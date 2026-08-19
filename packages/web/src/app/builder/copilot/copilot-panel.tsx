import { apId } from '@activepieces/core-utils';
import { FlowOperationType, FlowTrigger } from '@activepieces/shared';
import {
  Check,
  Loader2,
  PanelRight,
  PictureInPicture2,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import {
  PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import { RightSideBarType } from '@/app/builder/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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

// Default size of the floating dialog. The user can resize it from its bottom
// right corner afterwards.
const FLOATING_WIDTH_PX = 460;
const FLOATING_HEIGHT_PX = 620;
const FLOATING_MIN_WIDTH_PX = 320;
const FLOATING_MIN_HEIGHT_PX = 320;
const FLOATING_MARGIN_PX = 16;

type Point = { x: number; y: number };
type Size = { width: number; height: number };

// Keeps the dialog fully inside the viewport, so it can never be dragged (or
// resized, or shrunk by a window resize) out of reach.
const clampToViewport = (position: Point, size: Size): Point => ({
  x: Math.min(
    Math.max(position.x, 0),
    Math.max(window.innerWidth - size.width, 0),
  ),
  y: Math.min(
    Math.max(position.y, 0),
    Math.max(window.innerHeight - size.height, 0),
  ),
});

export const CopilotPanel = () => {
  const { t, i18n } = useTranslation();
  const [
    flow,
    flowVersion,
    applyOperation,
    readonly,
    setRightSidebar,
    isFloating,
    setCopilotFloating,
  ] = useBuilderStateContext((state) => [
    state.flow,
    state.flowVersion,
    state.applyOperation,
    state.readonly,
    state.setRightSidebar,
    state.isCopilotFloating,
    state.setCopilotFloating,
  ]);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dialogPosition, setDialogPosition] = useState<Point>({ x: 0, y: 0 });
  const [dialogSize, setDialogSize] = useState<Size>({
    width: FLOATING_WIDTH_PX,
    height: FLOATING_HEIGHT_PX,
  });
  const [isDragging, setIsDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The panel as it sits docked in the sidebar — measured so the dialog opens
  // roughly where the docked panel was.
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
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
          // Open the panel already scrolled to the latest message.
          scrollToBottom('auto');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    // Double rAF so the scroll runs after the newly rendered messages have
    // been laid out — important on first open where the list just mounted.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior,
        });
      });
    });
  };

  // Undock: the chat leaves the sidebar and becomes a floating window that
  // stays above the rest of the builder, so the canvas gets its space back and
  // the flow stays editable while you chat.
  const openAsDialog = () => {
    const size = {
      width: Math.min(
        FLOATING_WIDTH_PX,
        window.innerWidth - FLOATING_MARGIN_PX,
      ),
      height: Math.min(
        FLOATING_HEIGHT_PX,
        window.innerHeight - FLOATING_MARGIN_PX * 2,
      ),
    };
    // Open it where the docked panel was, so it does not jump across the screen.
    const dockedRect = containerRef.current?.getBoundingClientRect();
    const origin = {
      x:
        (dockedRect?.right ?? window.innerWidth) -
        size.width -
        FLOATING_MARGIN_PX,
      y: (dockedRect?.top ?? FLOATING_MARGIN_PX) + FLOATING_MARGIN_PX,
    };
    setDialogSize(size);
    setDialogPosition(clampToViewport(origin, size));
    setCopilotFloating(true);
    // Give the sidebar space back to the canvas while the dialog is floating.
    setRightSidebar(RightSideBarType.NONE);
  };

  const dockToSidebar = () => {
    setCopilotFloating(false);
    setRightSidebar(RightSideBarType.COPILOT);
  };

  const closePanel = () => {
    if (isFloating) {
      setCopilotFloating(false);
      return;
    }
    setRightSidebar(RightSideBarType.NONE);
  };

  const startDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Let the header buttons keep working — only bare header area drags.
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - dialogPosition.x,
      offsetY: event.clientY - dialogPosition.y,
    };
    setIsDragging(true);
  };

  const onDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDialogPosition(
      clampToViewport(
        { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
        dialogSize,
      ),
    );
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setIsDragging(false);
  };

  // The dialog is resizable from its corner (CSS resize), so mirror whatever
  // size the browser gives it — the drag clamping needs the real size.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isFloating || !dialog) return;
    const observer = new ResizeObserver(() => {
      // Border box, not contentRect — feeding the content size back into the
      // style would shrink the dialog by its border on every pass.
      const { width, height } = dialog.getBoundingClientRect();
      setDialogSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(dialog);
    return () => observer.disconnect();
  }, [isFloating]);

  // A smaller window must not leave the dialog stranded off-screen.
  useEffect(() => {
    if (!isFloating) return;
    const onResize = () =>
      setDialogPosition((previous) => clampToViewport(previous, dialogSize));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isFloating, dialogSize]);

  // Switching between docked and floating re-parents the chat in the DOM.
  useEffect(() => {
    scrollToBottom('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFloating]);

  const buildHistory = (nextItems: ChatItem[]): CopilotChatMessage[] =>
    nextItems.map((item) => ({
      role: item.role,
      content: item.kind === 'proposal' ? item.summary || item.text : item.text,
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
        locale: i18n.language,
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

  const toggleLabel = isFloating
    ? t('Dock to sidebar')
    : t('Open as floating window');

  const panelContent = (
    <div className="flex h-full w-full flex-col bg-background">
      <div
        onPointerDown={isFloating ? startDragging : undefined}
        onPointerMove={isFloating ? onDragging : undefined}
        onPointerUp={isFloating ? stopDragging : undefined}
        onPointerCancel={isFloating ? stopDragging : undefined}
        className={cn(
          'flex items-center justify-between border-b px-4 py-3',
          isFloating && 'touch-none select-none',
          isFloating && (isDragging ? 'cursor-grabbing' : 'cursor-grab'),
        )}
      >
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">{t('AI Copilot')}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={toggleLabel}
                aria-pressed={isFloating}
                onClick={isFloating ? dockToSidebar : openAsDialog}
              >
                {isFloating ? (
                  <PanelRight className="h-4 w-4" />
                ) : (
                  <PictureInPicture2 className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{toggleLabel}</TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('Close')}
            onClick={closePanel}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
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
              className={cn(
                'flex',
                item.role === 'user' ? 'justify-end' : 'justify-start',
              )}
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

  if (isFloating) {
    // Rendered on <body> so no builder panel can stack on top of it, and kept
    // non-modal so the canvas underneath stays clickable while you chat.
    return createPortal(
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={t('AI Copilot')}
        className="fixed z-[100] flex flex-col overflow-hidden rounded-lg border bg-background shadow-2xl duration-150 animate-in fade-in zoom-in-95"
        style={{
          left: dialogPosition.x,
          top: dialogPosition.y,
          width: dialogSize.width,
          height: dialogSize.height,
          minWidth: FLOATING_MIN_WIDTH_PX,
          minHeight: FLOATING_MIN_HEIGHT_PX,
          maxWidth: '100vw',
          maxHeight: '100vh',
          // Native corner grip — drag it to resize the dialog.
          resize: 'both',
        }}
      >
        {panelContent}
      </div>,
      document.body,
    );
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      {panelContent}
    </div>
  );
};
