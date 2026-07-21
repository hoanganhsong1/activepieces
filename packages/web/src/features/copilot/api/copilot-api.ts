import { FlowTrigger } from '@activepieces/shared';

import { api } from '@/lib/api';

export type GenerateFlowRequestBody = {
  prompt: string;
  model?: string;
  /** UI language (e.g. 'ja'); the copilot replies in this language. */
  locale?: string;
};

export type GenerateFlowResponse = {
  displayName: string;
  trigger: FlowTrigger;
  schemaVersion: string;
};

export type CopilotChatRole = 'user' | 'assistant';

export type CopilotChatMessage = {
  role: CopilotChatRole;
  content: string;
};

export type EditFlowRequestBody = {
  currentFlow: {
    displayName: string;
    trigger: FlowTrigger;
  };
  messages: CopilotChatMessage[];
  model?: string;
  /** UI language (e.g. 'ja'); the copilot replies in this language. */
  locale?: string;
};

export type EditFlowOption = {
  id: string;
  label: string;
};

export type EditFlowResponse =
  | { kind: 'message'; message: string }
  | { kind: 'question'; message: string; options: EditFlowOption[] }
  | {
      kind: 'proposal';
      message: string;
      summary: string;
      changes: string[];
      displayName: string;
      trigger: FlowTrigger;
      schemaVersion: string;
    };

export type CopilotConversationResponse = {
  messages: unknown[];
};

export const copilotApi = {
  generateFlow(request: GenerateFlowRequestBody) {
    return api.post<GenerateFlowResponse>(
      '/v1/copilot/generate-flow',
      request,
    );
  },
  editFlow(request: EditFlowRequestBody) {
    return api.post<EditFlowResponse>('/v1/copilot/edit-flow', request);
  },
  getConversation(flowId: string) {
    return api.get<CopilotConversationResponse>(
      `/v1/copilot/conversations/${flowId}`,
    );
  },
  saveConversation(flowId: string, messages: unknown[]) {
    return api.post<void>(`/v1/copilot/conversations/${flowId}`, { messages });
  },
};
