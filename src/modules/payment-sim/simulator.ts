import { randomUUID } from "crypto";

export interface PaymentWebhookPayload {
  eventId: string;
  event: "payment.succeeded" | "payment.failed";
  data: {
    reservationId: string;
    saleId: string;
    userId: string;
    quantity: number;
    paymentReference: string;
    amount: number;
  };
}

export interface SimulatorConfig {
  minDelayMs: number;
  maxDelayMs: number;
  failureRate: number; // 0.0 to 1.0
  webhookUrl?: string;
}

export interface TriggerPaymentInput {
  reservationId: string;
  saleId: string;
  userId: string;
  quantity?: number;
  delayMs?: number;
  forceOutcome?: "succeeded" | "failed";
}

export type DispatchHandler = (payload: PaymentWebhookPayload) => Promise<any> | any;

export class ChaosPaymentSimulator {
  private config: SimulatorConfig;
  private onDispatch?: DispatchHandler;
  private activeTimers: Set<NodeJS.Timeout> = new Set();

  constructor(options?: Partial<SimulatorConfig>, onDispatch?: DispatchHandler) {
    this.config = {
      minDelayMs: options?.minDelayMs ?? 500,
      maxDelayMs: options?.maxDelayMs ?? 3000,
      failureRate: options?.failureRate ?? 0.0,
      webhookUrl: options?.webhookUrl,
    };
    this.onDispatch = onDispatch;
  }

  setConfig(options: Partial<SimulatorConfig>): void {
    this.config = { ...this.config, ...options };
  }

  getConfig(): SimulatorConfig {
    return { ...this.config };
  }

  setOnDispatch(handler: DispatchHandler): void {
    this.onDispatch = handler;
  }

  private calculateDelay(requestedDelay?: number): number {
    if (typeof requestedDelay === "number") {
      return requestedDelay;
    }
    const { minDelayMs, maxDelayMs } = this.config;
    if (minDelayMs >= maxDelayMs) {
      return minDelayMs;
    }
    return Math.floor(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
  }

  private determineOutcome(forceOutcome?: "succeeded" | "failed"): "payment.succeeded" | "payment.failed" {
    if (forceOutcome) {
      return forceOutcome === "succeeded" ? "payment.succeeded" : "payment.failed";
    }
    const isFailure = Math.random() < this.config.failureRate;
    return isFailure ? "payment.failed" : "payment.succeeded";
  }

  public createPayload(input: TriggerPaymentInput): PaymentWebhookPayload {
    const outcome = this.determineOutcome(input.forceOutcome);
    return {
      eventId: `evt_${randomUUID()}`,
      event: outcome,
      data: {
        reservationId: input.reservationId,
        saleId: input.saleId,
        userId: input.userId,
        quantity: input.quantity ?? 1,
        paymentReference: `pay_${randomUUID()}`,
        amount: (input.quantity ?? 1) * 100,
      },
    };
  }

  public async dispatch(payload: PaymentWebhookPayload): Promise<void> {
    if (this.onDispatch) {
      try {
        await this.onDispatch(payload);
      } catch (err) {
        console.error("PaymentSimulator dispatch callback failed:", err);
      }
    }

    if (this.config.webhookUrl) {
      try {
        await fetch(this.config.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error(`PaymentSimulator webhook fetch failed to ${this.config.webhookUrl}:`, err);
      }
    }
  }

  public triggerPayment(input: TriggerPaymentInput): NodeJS.Timeout {
    const delay = this.calculateDelay(input.delayMs);
    const payload = this.createPayload(input);

    const timer = setTimeout(async () => {
      this.activeTimers.delete(timer);
      await this.dispatch(payload);
    }, delay);

    this.activeTimers.add(timer);
    return timer;
  }

  public async processPayment(input: TriggerPaymentInput): Promise<PaymentWebhookPayload> {
    const delay = this.calculateDelay(input.delayMs);
    const payload = this.createPayload(input);

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    await this.dispatch(payload);
    return payload;
  }

  public clearAll(): void {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }
}

export const defaultPaymentSimulator = new ChaosPaymentSimulator();
