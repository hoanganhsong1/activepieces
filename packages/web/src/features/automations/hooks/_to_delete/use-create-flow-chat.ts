import {
  FlowOperationType,
  FlowTrigger,
  UncategorizedFolderId,
} from '@activepieces/shared';
import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import {
  CopilotChatMessage,
  EditFlowOption,
  copilotApi,
} from '@/features/copilot/api/copilot-api';
import { flowsApi } from '@/features/flows/api/flows-api';
import { authenticationSession } from '@/lib/authentication-session';
import { NEW_FLOW_QUERY_PARAM } from '@/lib/route-utils';

type DraftFlow = {
  displayName: string;
  trigger: FlowTrigger;
  schemaVersion: string;
};

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; kind: 'message'; text: string }
  | {
      id: string;
      role: 'assistant';
      kind: 'question';
      text: string;
      options: EditFlowOption[];
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'proposal';
      text: string;
      summary: string;
      changes: string[];
    };

let messageCounter = 0;
const newId = () => {
  messageCounter += 1;
  return `msg_${messageCounter}`;
};

const extractErrorMessage = (error: unknown): string | undefined =>
  (
    error as {
      response?: { data?: { params?: { message?: string } } };
    }
  )?.response?.data?.params?.message;

type UseCreateFlowChatArgs = {
  folderId?: string;
};

/**
 * Owns the multi-turn "create a flow with AI" conversation.
 *
 * The first user turn generates a draft flow (copilot generate-flow); every
 * later turn refines it (copilot edit-flow), which can reply with a plain
 * message, a clarifying question, or a new proposal. Accepting the current
 * draft creates the flow and navigates into the builder — the same path the
 * previous single-shot dialog used.
 */
export function useCreateFlowChat({ folderId }: UseCreateFlowChatArgs = {}) {
  const navigate = useNavigate();
  const projectId = authenticationSession.getProjectId() ?? '';

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<DraftFlow | null>(null);
  // Running transcript sent to edit-flow. Kept alongside `messages` because it
  // uses the API's shape (role/content) rather than the richer UI shape.
  const [transcript, setTranscript] = useState<CopilotChatMessage[]>([]);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setDraft(null);
    setTranscript([]);
  }, []);

  const { mutateAsync: runTurn, isPending: isResponding } = useMutation({
    mutationFn: async (text: string) => {
      const nextTranscript: CopilotChatMessage[] = [
        ...transcript,
        { role: 'user', content: text },
      ];
      setTranscript(nextTranscript);

      if (!draft) {
        const generated = await copilotApi.generateFlow({ prompt: text });
        return { type: 'generated' as const, generated, nextTranscript };
      }

      const response = await copilotApi.editFlow({
        currentFlow: { displayName: draft.displayName, trigger: draft.trigger },
        messages: nextTranscript,
      });
      return { type: 'edited' as const, response, nextTranscript };
    },
    onSuccess: (result) => {
      if (result.type === 'generated') {
        const { generated, nextTranscript } = result;
        const name = generated.displayName || t('Untitled');
        setDraft({
          displayName: generated.displayName,
          trigger: generated.trigger,
          schemaVersion: generated.schemaVersion,
        });
        const text = t(
          'I drafted "{{name}}". Review the summary below, then create it or tell me what to change.',
          { name },
        );
        setTranscript([
          ...nextTranscript,
          { role: 'assistant', content: text },
        ]);
        appendMessage({
          id: newId(),
          role: 'assistant',
          kind: 'proposal',
          text,
          summary: name,
          changes: [],
        });
        return;
      }

      const { response, nextTranscript } = result;
      setTranscript([
        ...nextTranscript,
        { role: 'assistant', content: response.message },
      ]);

      if (response.kind === 'message') {
        appendMessage({
          id: newId(),
          role: 'assistant',
          kind: 'message',
          text: response.message,
        });
      } else if (response.kind === 'question') {
        appendMessage({
          id: newId(),
          role: 'assistant',
          kind: 'question',
          text: response.message,
          options: response.options,
        });
      } else {
        setDraft({
          displayName: response.displayName,
          trigger: response.trigger,
          schemaVersion: response.schemaVersion,
        });
        appendMessage({
          id: newId(),
          role: 'assistant',
          kind: 'proposal',
          text: response.message,
          summary: response.summary,
          changes: response.changes,
        });
      }
    },
    onError: (error: unknown) => {
      appendMessage({
        id: newId(),
        role: 'assistant',
        kind: 'message',
        text:
          extractErrorMessage(error) ??
          t('Something went wrong. Please try again.'),
      });
    },
  });

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isResponding) return;
      appendMessage({ id: newId(), role: 'user', text: trimmed });
      void runTurn(trimmed);
    },
    [appendMessage, isResponding, runTurn],
  );

  const { mutate: acceptDraft, isPending: isCreating } = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('No draft flow to create');
      const displayName = draft.displayName || t('Untitled');
      const createdFlow = await flowsApi.create({
        projectId,
        displayName,
        folderId:
          !folderId || folderId === UncategorizedFolderId ? undefined : folderId,
      });
      const flow = await flowsApi.update(createdFlow.id, {
        type: FlowOperationType.IMPORT_FLOW,
        request: {
          displayName,
          trigger: draft.trigger,
          schemaVersion: draft.schemaVersion,
          notes: [],
        },
      });
      // Best effort: persist the conversation so the in-builder copilot can
      // pick it up. A failure here must not block navigation to the new flow.
      try {
        await copilotApi.saveConversation(flow.id, transcript);
      } catch {
        // Non-fatal — the flow already exists.
      }
      return flow;
    },
    onSuccess: (flow) => {
      navigate(`/flows/${flow.id}?${NEW_FLOW_QUERY_PARAM}=true`);
    },
    onError: () => toast.error(t('Failed to create flow')),
  });

  return {
    messages,
    isResponding,
    isCreating,
    hasDraft: draft !== null,
    sendMessage,
    acceptDraft,
    reset,
  };
}
