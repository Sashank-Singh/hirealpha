export interface N8nWebhookResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Triggers a self-hosted n8n workflow via its webhook endpoint.
 * This allows agents to trigger 400+ SaaS automations (Slack, Gmail, CRM, Jira, etc.) for $0.
 */
export async function triggerN8nWorkflow(
  webhookPath: string,
  payload: Record<string, any>,
  n8nHost: string = process.env.N8N_HOST || "http://localhost:5678"
): Promise<N8nWebhookResponse> {
  const url = `${n8nHost.replace(/\/$/, "")}/webhook/${webhookPath.replace(/^\//, "")}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`n8n responded with status ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return {
      success: true,
      data,
    };
  } catch (error: any) {
    console.error("n8n webhook execution failed:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
