import {
  useLoaderData,
  useNavigate,
  useSubmit,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import {
  Page,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Grid,
  List,
  Banner,
  Spinner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { PLAN_BASIC, PLAN_PRO, PLAN_PLATINUM, PLAN_ORDER } from "../plans.js";
import {
  safeBillingCheck,
  safeBillingRequest,
  safeBillingCancel,
} from "../billing.server";
import prisma from "../db.server";
import { subscriptionPlans } from "../data/templates";

const ALL_PAID_PLANS = [PLAN_BASIC, PLAN_PRO, PLAN_PLATINUM];


// ─── Loader ────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);

  let subscription = null;
  let billingApiAvailable = true;

  // Step 1: Try to sync with Shopify's real billing state
  const billingCheck = await safeBillingCheck(billing, ALL_PAID_PLANS);
  billingApiAvailable = billingCheck.available;

  if (billingCheck.available) {
    if (billingCheck.hasActivePayment) {
      // Shopify confirms an active subscription — sync it to DB
      const activeSub = billingCheck.appSubscriptions?.[0];
      const planName = activeSub?.name;

      if (planName && ALL_PAID_PLANS.includes(planName)) {
        try {
          subscription = await prisma.subscription.upsert({
            where: { shop: session.shop },
            create: {
              shop: session.shop,
              plan: planName,
              status: "ACTIVE",
              subscriptionId: activeSub?.id || null,
              currentPeriodEnd: activeSub?.currentPeriodEnd
                ? new Date(activeSub.currentPeriodEnd)
                : null,
            },
            update: {
              plan: planName,
              status: "ACTIVE",
              subscriptionId: activeSub?.id || null,
              currentPeriodEnd: activeSub?.currentPeriodEnd
                ? new Date(activeSub.currentPeriodEnd)
                : null,
            },
          });
        } catch (dbErr) {
          console.error("DB sync error:", dbErr);
        }
      }
    } else {
      // Shopify says no active subscription — downgrade any paid DB record
      try {
        const dbSub = await prisma.subscription.findUnique({
          where: { shop: session.shop },
        });
        if (dbSub && dbSub.status === "ACTIVE" && dbSub.plan !== "FREE") {
          subscription = await prisma.subscription.update({
            where: { shop: session.shop },
            data: { plan: "FREE", status: "ACTIVE", subscriptionId: null },
          });
        } else {
          subscription = dbSub;
        }
      } catch (dbErr) {
        console.error("DB downgrade check error:", dbErr);
      }
    }
  } else {
    // Billing API unavailable (Custom App / 403) — trust the DB as source of truth
    try {
      subscription = await prisma.subscription.findUnique({
        where: { shop: session.shop },
      });
    } catch (dbErr) {
      console.error("DB fallback lookup error:", dbErr);
    }
  }

  return { subscription, billingApiAvailable };
};

// ─── Action ─────────────────────────────────────────────────────────────────
export const action = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan");

  if (!plan) throw new Response("Missing plan field", { status: 400 });

  // ── FREE DOWNGRADE ──────────────────────────────────────────────────────
  if (plan === "FREE") {
    // Try to cancel Shopify subscription (best-effort — may be unavailable for Custom Apps)
    try {
      const existing = await prisma.subscription.findUnique({
        where: { shop: session.shop },
      });
      if (existing?.subscriptionId) {
        await safeBillingCancel(billing, existing.subscriptionId);
      }
    } catch (lookupErr) {
      console.warn("Could not look up existing subscription for cancel:", lookupErr.message);
    }

    // Always update DB regardless of Shopify API result
    try {
      await prisma.subscription.upsert({
        where: { shop: session.shop },
        create: { shop: session.shop, plan: "FREE", status: "ACTIVE" },
        update: { plan: "FREE", status: "ACTIVE", subscriptionId: null },
      });
    } catch (dbErr) {
      console.error("DB error during FREE downgrade:", dbErr);
      throw new Response("Database error while downgrading plan", { status: 500 });
    }
    return { success: true };
  }

  // ── PAID PLAN UPGRADE ───────────────────────────────────────────────────
  const returnUrl = `${process.env.SHOPIFY_APP_URL}/billing/callback`;

  // Mark as PENDING before redirecting so we know a request is in flight
  try {
    await prisma.subscription.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, plan, status: "PENDING" },
      update: { plan, status: "PENDING" },
    });
  } catch (dbErr) {
    console.error("DB PENDING upsert error:", dbErr);
  }

  const billingResult = await safeBillingRequest(billing, plan, returnUrl);

  if (billingResult.available && billingResult.redirect) {
    // Shopify Billing API is available — redirect to approval page
    return billingResult.redirect;
  }

  // Billing API is not available for this app type (Custom App / 403).
  // We do NOT grant access silently. Instead, revert to FREE and inform the user.
  try {
    await prisma.subscription.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, plan: "FREE", status: "ACTIVE" },
      update: { plan: "FREE", status: "ACTIVE" },
    });
  } catch (_) {}

  // Return a structured response the UI can display as an informative banner
  return {
    success: false,
    billingUnavailable: true,
    message:
      "Shopify Billing is not available for this app type. " +
      "To enable paid plans, this app must be published to the Shopify App Store or " +
      "have billing enabled in the Shopify Partners Dashboard.",
  };
};

// ─── UI Helpers ──────────────────────────────────────────────────────────────

function getPlanButtonLabel(planId, currentPlan) {
  if (planId === currentPlan) return "Current Plan";
  const currentIndex = PLAN_ORDER.indexOf(currentPlan);
  const targetIndex = PLAN_ORDER.indexOf(planId);
  if (targetIndex > currentIndex) return "Upgrade";
  if (targetIndex < currentIndex) return "Downgrade";
  return "Select";
}

function getPlanBadgeTone(planId) {
  switch (planId) {
    case PLAN_BASIC: return "info";
    case PLAN_PRO: return "attention";
    case PLAN_PLATINUM: return "warning";
    default: return "success";
  }
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function PricingPage() {
  const { subscription, billingApiAvailable } = useLoaderData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const isSubmitting = navigation.state === "submitting";
  const userPlan =
    subscription?.status === "ACTIVE" ? subscription?.plan || "FREE" : "FREE";
  const billingStatus = searchParams.get("billingStatus");
  const accessDeniedTier = searchParams.get("accessDenied");

  const handleSubscribe = (planId) => {
    submit({ plan: planId }, { method: "post" });
  };

  const statusBanner = () => {
    if (accessDeniedTier) {
      const tierName = accessDeniedTier.replace("PLAN_", "");
      return (
        <Banner tone="warning" title={`${tierName} Plan Required`}>
          That layout requires a {tierName} subscription or higher. Upgrade today to access premium sections and boost your conversions!
        </Banner>
      );
    }
    if (billingStatus === "success") {
      return (
        <Banner tone="success" title="Subscription activated!">
          Your plan has been upgraded and features are now unlocked.
        </Banner>
      );
    }
    if (billingStatus === "cancelled") {
      return (
        <Banner tone="warning" title="Payment cancelled">
          You cancelled the subscription approval. No charge was made.
        </Banner>
      );
    }
    if (billingStatus === "error") {
      return (
        <Banner tone="critical" title="Billing error">
          Something went wrong verifying your subscription. Please try again.
        </Banner>
      );
    }
    return null;
  };

  return (
    <Page
      title="Subscription Plans"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">

        {/* Billing API unavailability notice */}
        {!billingApiAvailable && (
          <Banner tone="warning" title="Live billing unavailable">
            The Shopify Billing API is not accessible for this app type (Custom
            App or billing not yet enabled in the Partners Dashboard). Plan
            information shown is based on your last known database record.
            To enable real subscription billing, publish this app to the
            Shopify App Store.
          </Banner>
        )}

        {/* Billing status banners */}
        {statusBanner()}

        {/* Active subscription info */}
        {subscription?.status === "ACTIVE" && subscription?.plan !== "FREE" && (
          <Banner tone="info" title={`Active: ${subscription.plan.replace("PLAN_", "")} Plan`}>
            {subscription.currentPeriodEnd && (
              <Text>
                Current period ends:{" "}
                {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </Text>
            )}
          </Banner>
        )}

        {subscription?.status === "PENDING" && (
          <Banner tone="attention" title="Awaiting payment approval">
            A subscription request is pending. Complete the payment on
            Shopify&apos;s approval page to activate your plan.
          </Banner>
        )}

        <Text variant="bodyLg" as="p" alignment="center">
          Experience the power of ShopFrame premium layout sections and start elevating your store's
          experience. Free layouts are always included with every plan.
        </Text>

        <Grid>
          {subscriptionPlans.map((plan) => {
            const isCurrent = userPlan === plan.id;
            const buttonLabel = getPlanButtonLabel(plan.id, userPlan);
            const isPaidPlan = plan.id !== "FREE";
            const isThisPlanSubmitting =
              navigation.state === "submitting" &&
              navigation.formData?.get("plan") === plan.id;

            return (
              <Grid.Cell
                key={plan.id}
                columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}
              >
                <Card
                  background={
                    isCurrent ? "bg-surface-secondary" : "bg-surface"
                  }
                >
                  <BlockStack gap="500">
                    <BlockStack gap="200" align="center" inlineAlign="center">
                      {isCurrent && (
                        <Badge tone={getPlanBadgeTone(plan.id)}>
                          Current Plan
                        </Badge>
                      )}
                      <Text variant="headingLg" as="h3">
                        {plan.name}
                      </Text>
                      <Text variant="headingXl" as="h4">
                        ${plan.price}
                        <Text as="span" variant="bodyMd" tone="subdued">
                          /mo
                        </Text>
                      </Text>
                      {isPaidPlan && (
                        <Text variant="bodySm" tone="subdued">
                          Includes all Free features
                        </Text>
                      )}
                    </BlockStack>

                    <div style={{ minHeight: "200px" }}>
                      <List type="bullet">
                        {plan.features.map((feature, i) => (
                          <List.Item key={i}>{feature}</List.Item>
                        ))}
                      </List>
                    </div>

                    <Button
                      fullWidth
                      variant={isCurrent ? "secondary" : "primary"}
                      disabled={isCurrent}
                      loading={isThisPlanSubmitting}
                      onClick={() => handleSubscribe(plan.id)}
                    >
                      {isThisPlanSubmitting ? "Processing..." : buttonLabel}
                    </Button>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            );
          })}
        </Grid>

        <Card>
          <BlockStack gap="200">
            <Text variant="headingSm" as="h3">
              ✅ Free plan is always available
            </Text>
            <BlockStack gap="200">
              <Text as="p">
              Free layouts remain accessible regardless of your subscription
              status. Upgrading adds access to premium layouts; it never
              removes access to free ones.
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
