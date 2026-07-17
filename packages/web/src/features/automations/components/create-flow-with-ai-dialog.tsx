import { t } from 'i18next';
import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

const EXAMPLE_PROMPTS = [
  'Every morning at 9am, send me a Chatwork message with today’s weather',
  'When a new row is added to a Google Sheet, send a Slack notification',
  'Every hour, fetch data from an API and save it to a table',
];

type CreateFlowWithAiDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isGenerating: boolean;
  onSubmit: (prompt: string) => void;
};

export const CreateFlowWithAiDialog = ({
  open,
  onOpenChange,
  isGenerating,
  onSubmit,
}: CreateFlowWithAiDialogProps) => {
  const [prompt, setPrompt] = useState('');

  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && !isGenerating;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Prevent closing while a flow is being generated.
        if (isGenerating && !next) return;
        if (!next) setPrompt('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('Create a flow with AI')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'Describe what you want to automate. The AI will pick the trigger and actions and build a draft flow you can refine.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Textarea
            autoFocus
            value={prompt}
            disabled={isGenerating}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={t('e.g. When I get a new email in Gmail, save the attachment to Google Drive')}
            className="min-h-[120px] resize-none"
          />

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t('Need inspiration? Try one of these:')}
            </span>
            <div className="flex flex-col gap-1">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={isGenerating}
                  onClick={() => setPrompt(example)}
                  className="text-left text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  • {example}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={isGenerating}
            onClick={() => onOpenChange(false)}
          >
            {t('Cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('Building your flow...')}
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                {t('Generate flow')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
