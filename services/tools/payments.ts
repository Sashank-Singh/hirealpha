import Stripe from "stripe";

// Initialize Stripe with secret key or fallback to mock mode if not set in dev
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "sk_test_mock_key_for_development";
const stripe = new Stripe(stripeSecretKey);

export interface PaymentLinkResult {
  url: string;
  sessionId?: string;
  amount: number;
  item: string;
  mode: "live" | "mock";
}

/**
 * Creates a secure, one-click Stripe Payment Checkout Link for the user.
 * Supports credit card, Apple Pay, and Google Pay.
 */
export async function createStripePaymentLink(params: {
  itemName: string;
  amountDollars: number;
  customerEmail?: string;
  metadata?: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<PaymentLinkResult> {
  const {
    itemName,
    amountDollars,
    customerEmail,
    metadata = {},
    successUrl = "https://yourapp.com/booking-confirmed?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl = "https://yourapp.com/booking-cancelled",
  } = params;

  const unitAmountCents = Math.round(amountDollars * 100);

  // If running in development without a real Stripe key, generate a realistic simulated checkout URL
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.startsWith("sk_test_mock")) {
    const mockSessionId = `cs_test_${Math.random().toString(36).substring(2, 15)}`;
    return {
      url: `https://checkout.stripe.com/c/pay/${mockSessionId}?item=${encodeURIComponent(itemName)}&amount=${unitAmountCents}`,
      sessionId: mockSessionId,
      amount: amountDollars,
      item: itemName,
      mode: "mock",
    };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: itemName,
            },
            unit_amount: unitAmountCents,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: customerEmail,
      metadata: {
        ...metadata,
        generatedBy: "AI Subagent",
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return {
      url: session.url || `https://checkout.stripe.com/pay/${session.id}`,
      sessionId: session.id,
      amount: amountDollars,
      item: itemName,
      mode: "live",
    };
  } catch (error: any) {
    console.error("Stripe Checkout Link creation error:", error);
    throw new Error(`Failed to generate Stripe payment link: ${error.message}`);
  }
}
