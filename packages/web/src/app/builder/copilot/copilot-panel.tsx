import { apId } from '@activepieces/core-utils';
import { FlowOperationType, FlowTrigger } from '@activepieces/shared';
import { t } from 'i18next';
import { Check, Loader2, Send, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import { RightSideBarType } from '@/app/builder/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  copilotApi,
  CopilotChatMessage,
  EditFlowOption,
} from '@/features/copilot/api/copilot-api';
import { cn } from '@/lib/utils';

type ChatItem =
  | { id: string; role: 'user'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'text'; text: string }
  | {
      id: string;
      role: 'assistant';
      kind: 'question';
      text: string;
      options: EditFlowOption[];
      answered: boolean;
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'proposal';
      text: string;
      summary: string;
      changes: string[];
      displayName: string;
      trigger: FlowTrigger;
      schemaVersion: string;
      status: 'pending' | 'applied' | 'discarded';
    };

const SUGGESTIONS = [
  'Add a step to send me a Chatwork message when it runs',
  'Change the trigger to run every hour instead',
  'Add error handling so it keeps going on failure',
];

export const CopilotPanel = () => {
  const [flow, flowVersion, applyOperation, readonly, setRightSidebar] =
    useBuilderStateContext((state) => [
      state.flow,
      state.flowVersion,
      state.applyOperation,
      state.readonly,
      state.setRightSidebar,
    ]);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Prevents the persist effect from firing (and overwriting saved history)
  // before the initial load for this flow has completed.
  const loadedRef = useRef(false);
  // Always points at the latest items so the debounced save and the
  // unmount-flush persist the newest state, never a stale closure value.
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;

  const persistNow = () => {
    if (!loadedRef.current) return;
    copilotApi
      .saveConversation(flow.id, itemsRef.current)
      .catch((error: unknown) => {
        const description = (
          error as { response?: { data?: { params?: { message?: string } } } }
        )?.response?.data?.params?.message;
        // eslint-disable-next-line no-console
        console.error('[copilot] failed to save conversation', error);
        toast.error(
          t('Could not save chat'),
          description ? { description } : undefined,
        );
      });
  };

  // Load the saved conversation whenever the open flow changes.
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setItems([]);
    copilotApi
      .getConversation(flow.id)
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.messages)) {
          setItems(res.messages as ChatItem[]);
        }
        loadedRef.current = true;
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[copilot] failed to load conversation', error);
        loadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [flow.id]);

  // Persist the conversation after each change, once the initial load is done.
  // Debounced so a burst of updates (send → response → apply) coalesces into
  // a single save instead of racing multiple writes.
  useEffect(() => {
    if (!loadedRef.current) return;
    const timer = setTimeout(persistNow, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, flow.id]);

  // Flush the latest conversation when the panel closes or the flow changes,
  // so a save still pending in the debounce window is never lost.
  useEffect(() => {
    return () => {
      persistNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.id]);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  };

  const buildHistory = (nextItems: ChatItem[]): CopilotChatMessage[] =>
    nextItems.map((item) => ({
      role: item.role,
      content:
        item.kind === 'proposal'
          ? item.summary || item.text
          : item.text,
    }));

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    const userItem: ChatItem = {
      id: apId(),
      role: 'user',
      kind: 'text',
      text: trimmed,
    };
    const nextItems = [...items, userItem];
    setItems(nextItems);
    setInput('');
    setIsLoading(true);
    scrollToBottom();

    try {
      const response = await copilotApi.editFlow({
        currentFlow: {
          displayName: flowVersion.displayName,
          trigger: flowVersion.trigger,
        },
        messages: buildHistory(nextItems),
      });

      let assistantItem: ChatItem;
      if (response.kind === 'question') {
        assistantItem = {
          id: apId(),
          role: 'assistant',
          kind: 'question',
          text: response.message,
          options: response.options,
          answered: false,
        };
      } else if (response.kind === 'proposal') {
        assistantItem = {
          id: apId(),
          role: 'assistant',
          kind: 'proposal',
          text: response.message,
          summary: response.summary,
          changes: response.changes,
          displayName: response.displayName,
          trigger: response.trigger,
          schemaVersion: response.schemaVersion,
          status: 'pending',
        };
      } else {
        assistantItem = {
          id: apId(),
          role: 'assistant',
          kind: 'text',
          text: response.message,
        };
      }
      setItems((prev) => [...prev, assistantItem]);
      scrollToBottom();
    } catch (error: unknown) {
      const description = (
        error as { response?: { data?: { params?: { message?: string } } } }
      )?.response?.data?.params?.message;
      toast.error(
        t('AI copilot failed'),
        description ? { description } : undefined,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const answerQuestion = (questionId: string, option: EditFlowOption) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === questionId && item.kind === 'question'
          ? { ...item, answered: true }
          : item,
      ),
    );
    sendMessage(option.label);
  };

  const applyProposal = (proposalId: string) => {
    const proposal = items.find(
      (item): item is Extract<ChatItem, { kind: 'proposal' }> =>
        item.id === proposalId && item.kind === 'proposal',
    );
    if (!proposal || readonly) return;

    applyOperation(
      {
        type: FlowOperationType.IMPORT_FLOW,
        request: {
          displayName: proposal.displayName,
          trigger: proposal.trigger,
          schemaVersion: proposal.schemaVersion,
          notes: flowVersion.notes ?? [],
        },
      },
      () => {
        toast.success(t('Flow updated'));
      },
    );
    setItems((prev) =>
      prev.map((item) =>
        item.id === proposalId && item.kind === 'proposal'
          ? { ...item, status: 'applied' }
          : item,
      ),
    );
  };

  const discardProposal = (proposalId: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === proposalId && item.kind === 'proposal'
          ? { ...item, status: 'discarded' }
          : item,
      ),
    );
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">{t('AI Copilot')}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setRightSidebar(RightSideBarType.NONE)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1" viewPortRef={scrollRef}>
        <div className="flex flex-col gap-3 p-4">
          {items.length === 0 && (
            <div className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>
                {t(
                  'Ask me to change this flow — add steps, swap the trigger, tweak inputs. I’ll show you what changes before applying.',
                )}
              </p>
              <div className="flex flex-col gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => sendMessage(s)}
                    className="rounded-md border border-dashed px-3 py-2 text-left text-xs hover:bg-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {items.map((item) => (
            <div
              key={item.id}
              className={cn('flex', item.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[90%] rounded-lg px-3 py-2 text-sm',
                  item.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted',
                )}
              >
                {item.kind !== 'proposal' && (
                  <span className="whitespace-pre-wrap">{item.text}</span>
                )}

                {item.kind === 'question' && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {item.options.map((option) => (
                      <Button
                        key={option.id}
                        size="sm"
                        variant="outline"
                        disabled={item.answered || isLoading}
                        onClick={() => answerQuestion(item.id, option)}
                        className="justify-start"
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                )}

                {item.kind === 'proposal' && (
                  <div className="flex flex-col gap-2">
                    <span className="font-medium">{item.summary}</span>
                    {item.changes.length > 0 && (
                      <ul className="list-disc pl-4 text-xs text-muted-foreground">
                        {item.changes.map((change, i) => (
                          <li key={i}>{change}</li>
                        ))}
                      </ul>
                    )}
                    {item.status === 'pending' && (
                      <div className="mt-1 flex gap-2">
                        <Button
                          size="sm"
                          disabled={readonly}
                          onClick={() => applyProposal(item.id)}
                        >
                          <Check className="mr-1 h-3.5 w-3.5" />
                          {t('Apply')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => discardProposal(item.id)}
                        >
                          {t('Discard')}
                        </Button>
                      </div>
                    )}
                    {item.status === 'applied' && (
                      <span className="text-xs font-medium text-green-600">
                        {t('Applied to flow')}
                      </span>
                    )}
                    {item.status === 'discarded' && (
                      <span className="text-xs text-muted-foreground">
                        {t('Discarded')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('Thinking...')}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        {readonly && (
          <p className="mb-2 text-xs text-muted-foreground">
            {t('This flow is read-only. Switch to draft to apply changes.')}
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            disabled={isLoading}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input);
              }
            }}
            placeholder={t('Ask the copilot to change this flow...')}
            className="max-h-32 min-h-[44px] resize-none"
          />
          <Button
            size="icon"
            disabled={!input.trim() || isLoading}
            onClick={() => sendMessage(input)}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
