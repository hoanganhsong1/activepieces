import {
    ActivepiecesError,
    AIProviderName,
    ErrorCode,
    isNil,
} from '@activepieces/core-utils'
import { chatAiUtils } from '@activepieces/server-utils'
import {
    FlowActionType,
    FlowTrigger,
    FlowTriggerType,
    LATEST_FLOW_SCHEMA_VERSION,
    SuggestionType,
} from '@activepieces/shared'
import { generateText, LanguageModel, ModelMessage, stepCountIs, tool, ToolSet } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { aiProviderService } from '../ai/ai-provider-service'
import { pieceMetadataService } from '../pieces/metadata/piece-metadata-service'

/**
 * Reasonable default chat model per provider. The caller may override with an
 * explicit `model` in the request. Kept intentionally small — extend as needed.
 */
const DEFAULT_MODEL_BY_PROVIDER: Partial<Record<AIProviderName, string>> = {
    [AIProviderName.OPENAI]: 'gpt-4o',
    [AIProviderName.ANTHROPIC]: 'claude-sonnet-5',
    [AIProviderName.GOOGLE]: 'gemini-2.5-flash',
    [AIProviderName.AZURE]: 'gpt-4o',
    [AIProviderName.BEDROCK]: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    [AIProviderName.MISTRAL]: 'mistral-large-latest',
    [AIProviderName.OPENROUTER]: 'openai/gpt-4o',
    [AIProviderName.ACTIVEPIECES]: 'openai/gpt-4o',
    [AIProviderName.CLOUDFLARE_GATEWAY]: 'gpt-4o',
    [AIProviderName.CUSTOM]: 'gpt-4o',
}

const PROCESS_RULES = `Process — follow it strictly:
1. Call "search_pieces" one or more times to discover pieces whose triggers/actions match the capabilities needed.
   - Search by CAPABILITY using 1-2 generic English keywords (e.g. "date", "current date", "schedule", "send email", "google sheets", "http request").
   - IGNORE company, brand, project or person names in the request (e.g. "motomura") and any invented feature names the user made up (e.g. "Date Range Generator"): these are almost never real piece names. Translate the intent into a generic capability and search for that — for "get today's date" search "current date" or "date".
   - If a search returns nothing, retry with a shorter, more generic single keyword before concluding. NEVER tell the user a piece does not exist until you have tried generic capability searches.
2. Call "get_piece_details" for every piece you intend to use, to read the exact trigger/action names and their input parameters. search_pieces only lists a few suggested actions, so always open a promising piece with get_piece_details to see its FULL action list. NEVER invent a pieceName, triggerName, actionName or input key — only use values returned by the tools.

Rules:
- Prefer official pieces. If no event-based trigger fits, use the "@activepieces/piece-schedule" piece's "cron_expression" or "every_x_minutes" trigger.
- Fill "input" for triggers/actions using ONLY parameter keys returned by get_piece_details. Provide sensible values; leave a parameter out if you don't have a value for it.
- Reference earlier steps with {{trigger['output'].field}} or {{step_1['output'].field}} syntax when one step needs another step's data.`

const GENERATE_SYSTEM_PROMPT = `You are an automation architect for Activepieces. The user describes what they want to automate, and you design a working flow with exactly ONE trigger followed by an ordered list of actions.

${PROCESS_RULES}

When confident, call "submit_flow" EXACTLY ONCE with the final design. Do not ask follow-up questions; make reasonable assumptions.`

const EDIT_SYSTEM_PROMPT = `You are an automation copilot editing an EXISTING Activepieces flow. The user will ask for changes in a conversation.

${PROCESS_RULES}

You have one output tool, "respond". Call it exactly once per turn:
- kind="proposal": you know the change. Provide "summary" (one line), "changes" (short bullet strings describing what changes), and "flow" = the COMPLETE new flow (trigger + ALL steps, including unchanged ones — this replaces the whole flow, so never omit existing steps you want to keep).
- kind="question": you must ask the user to choose before proceeding. Provide "message" and 2-4 "options" (each { id, label }). Use this whenever there is a meaningful choice (which trigger, which piece, ambiguous target).
- kind="message": you are only answering/clarifying and NOT changing the flow. Provide "message".

Always prefer kind="question" over guessing when the request is ambiguous.`

/**
 * Supported UI languages, keyed by the locale code the web app sends. Used to
 * tell the model which language to write user-facing text in.
 */
const LANGUAGE_NAMES: Record<string, string> = {
    en: 'English',
    ja: 'Japanese',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    nl: 'Dutch',
    zh: 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    pt: 'Portuguese',
    ru: 'Russian',
    ar: 'Arabic',
}

// Normalize an incoming UI locale (e.g. "ja", "en-US") to a supported key.
function normalizeLocale(locale: string | undefined): string | undefined {
    if (isNil(locale) || locale === '') {
        return undefined
    }
    if (locale in LANGUAGE_NAMES) {
        return locale
    }
    const base = locale.split('-')[0]
    return base in LANGUAGE_NAMES ? base : undefined
}

// System-prompt suffix instructing the model to write user-facing text in the
// user's language. Identifiers (piece/trigger/action names and input keys) stay
// exactly as returned by the tools so the generated flow remains valid.
function languageInstruction(locale: string | undefined): string {
    const key = normalizeLocale(locale)
    if (isNil(key) || key === 'en') {
        return ''
    }
    const language = LANGUAGE_NAMES[key]
    return `\n\nLANGUAGE: Write ALL user-facing text in ${language} — the flow displayName, every step displayName, and (when editing) the summary, changes, message, question text and option labels. Do NOT translate identifiers: pieceName, triggerName, actionName and input parameter keys must stay exactly as returned by the tools.`
}

type CopilotMessageKey =
    | 'noWorkflow'
    | 'cannotProcess'
    | 'whichOption'
    | 'proposalHeader'
    | 'proposedChange'
    | 'needMoreDetail'

// Localized fallbacks for the fixed messages the copilot emits when the model
// omits its own text. AI-generated content is localized via the system prompt;
// these cover the code-provided defaults. Unlisted locales fall back to English.
const COPILOT_MESSAGES: Record<string, Record<CopilotMessageKey, string>> = {
    en: {
        noWorkflow: 'The AI did not produce a workflow. Try rephrasing your request with more detail.',
        cannotProcess: 'I could not process that request. Please try again.',
        whichOption: 'Which option would you like?',
        proposalHeader: 'Here is the proposed change.',
        proposedChange: 'Proposed change',
        needMoreDetail: 'I need a bit more detail to change the flow.',
    },
    ja: {
        noWorkflow: 'AIがワークフローを生成できませんでした。もう少し詳しく内容を記述して、もう一度お試しください。',
        cannotProcess: 'リクエストを処理できませんでした。もう一度お試しください。',
        whichOption: 'どのオプションを選択しますか？',
        proposalHeader: '提案された変更は次のとおりです。',
        proposedChange: '変更の提案',
        needMoreDetail: 'フローを変更するには、もう少し詳しい情報が必要です。',
    },
    de: {
        noWorkflow: 'Die KI hat keinen Flow erstellt. Formuliere deine Anfrage mit mehr Details neu.',
        cannotProcess: 'Ich konnte diese Anfrage nicht verarbeiten. Bitte versuche es erneut.',
        whichOption: 'Welche Option möchtest du?',
        proposalHeader: 'Hier ist die vorgeschlagene Änderung.',
        proposedChange: 'Vorgeschlagene Änderung',
        needMoreDetail: 'Ich brauche noch etwas mehr Details, um den Flow zu ändern.',
    },
    es: {
        noWorkflow: 'La IA no generó ningún flujo. Intenta reformular tu solicitud con más detalles.',
        cannotProcess: 'No pude procesar esa solicitud. Inténtalo de nuevo.',
        whichOption: '¿Qué opción prefieres?',
        proposalHeader: 'Este es el cambio propuesto.',
        proposedChange: 'Cambio propuesto',
        needMoreDetail: 'Necesito un poco más de detalle para cambiar el flujo.',
    },
    fr: {
        noWorkflow: 'L\'IA n\'a produit aucun flux. Essaie de reformuler ta demande avec plus de détails.',
        cannotProcess: 'Je n\'ai pas pu traiter cette demande. Réessaie.',
        whichOption: 'Quelle option souhaites-tu ?',
        proposalHeader: 'Voici la modification proposée.',
        proposedChange: 'Modification proposée',
        needMoreDetail: 'J\'ai besoin d\'un peu plus de détails pour modifier le flux.',
    },
    nl: {
        noWorkflow: 'De AI heeft geen flow gemaakt. Probeer je verzoek met meer details te herformuleren.',
        cannotProcess: 'Ik kon dat verzoek niet verwerken. Probeer het opnieuw.',
        whichOption: 'Welke optie wil je?',
        proposalHeader: 'Dit is de voorgestelde wijziging.',
        proposedChange: 'Voorgestelde wijziging',
        needMoreDetail: 'Ik heb wat meer details nodig om de flow te wijzigen.',
    },
    pt: {
        noWorkflow: 'A IA não gerou nenhum fluxo. Tente reformular sua solicitação com mais detalhes.',
        cannotProcess: 'Não consegui processar essa solicitação. Tente novamente.',
        whichOption: 'Qual opção você prefere?',
        proposalHeader: 'Esta é a alteração proposta.',
        proposedChange: 'Alteração proposta',
        needMoreDetail: 'Preciso de um pouco mais de detalhes para alterar o fluxo.',
    },
    ru: {
        noWorkflow: 'ИИ не создал поток. Попробуйте переформулировать запрос, добавив больше деталей.',
        cannotProcess: 'Не удалось обработать этот запрос. Пожалуйста, попробуйте ещё раз.',
        whichOption: 'Какой вариант вы предпочитаете?',
        proposalHeader: 'Вот предлагаемое изменение.',
        proposedChange: 'Предлагаемое изменение',
        needMoreDetail: 'Мне нужно немного больше деталей, чтобы изменить поток.',
    },
    zh: {
        noWorkflow: 'AI 未能生成流程。请尝试用更多细节重新描述你的请求。',
        cannotProcess: '无法处理该请求。请重试。',
        whichOption: '你想选择哪个选项？',
        proposalHeader: '以下是建议的更改。',
        proposedChange: '建议的更改',
        needMoreDetail: '我需要更多细节才能更改流程。',
    },
    'zh-TW': {
        noWorkflow: 'AI 未能產生流程。請嘗試以更多細節重新描述你的請求。',
        cannotProcess: '無法處理該請求。請重試。',
        whichOption: '你想選擇哪個選項？',
        proposalHeader: '以下是建議的變更。',
        proposedChange: '建議的變更',
        needMoreDetail: '我需要更多細節才能變更流程。',
    },
    ar: {
        noWorkflow: 'لم ينشئ الذكاء الاصطناعي أي تدفق. حاول إعادة صياغة طلبك بمزيد من التفاصيل.',
        cannotProcess: 'تعذّر معالجة هذا الطلب. يرجى المحاولة مرة أخرى.',
        whichOption: 'أي خيار تفضّل؟',
        proposalHeader: 'هذا هو التغيير المقترح.',
        proposedChange: 'التغيير المقترح',
        needMoreDetail: 'أحتاج إلى مزيد من التفاصيل لتغيير التدفق.',
    },
}

function copilotMessage(locale: string | undefined, key: CopilotMessageKey): string {
    const norm = normalizeLocale(locale)
    const table = (norm !== undefined && COPILOT_MESSAGES[norm]) || COPILOT_MESSAGES.en
    return table[key]
}

const PlanTrigger = z.object({
    pieceName: z.string().describe('Exact piece name from the tools, e.g. "@activepieces/piece-schedule"'),
    triggerName: z.string().describe('Exact trigger name returned by get_piece_details'),
    displayName: z.string().describe('Short label for this trigger'),
    input: z.record(z.string(), z.any()).default({}),
})

const PlanStep = z.object({
    pieceName: z.string(),
    actionName: z.string().describe('Exact action name returned by get_piece_details'),
    displayName: z.string(),
    input: z.record(z.string(), z.any()).default({}),
})

const FlowPlan = z.object({
    displayName: z.string().describe('Short, human-friendly name for the whole flow'),
    trigger: PlanTrigger,
    steps: z.array(PlanStep).default([]),
})

type FlowPlan = z.infer<typeof FlowPlan>

const RespondInput = z.object({
    kind: z.enum(['proposal', 'question', 'message']),
    message: z.string().optional().describe('Assistant message to show the user'),
    summary: z.string().optional().describe('One-line summary of the change (kind=proposal)'),
    changes: z.array(z.string()).optional().describe('Short bullet strings describing what changes (kind=proposal)'),
    options: z.array(z.object({ id: z.string(), label: z.string() })).optional().describe('Choices for the user (kind=question)'),
    flow: FlowPlan.optional().describe('The complete new flow (kind=proposal)'),
})

export type GenerateFlowResult = {
    displayName: string
    trigger: FlowTrigger
    schemaVersion: string
}

export type EditFlowResult =
    | { kind: 'message', message: string }
    | { kind: 'question', message: string, options: Array<{ id: string, label: string }> }
    | {
        kind: 'proposal'
        message: string
        summary: string
        changes: string[]
        displayName: string
        trigger: FlowTrigger
        schemaVersion: string
    }

export const copilotFlowGenerator = (log: FastifyBaseLogger) => ({
    async generateFlow({ platformId, projectId, prompt, model: requestedModel, locale }: GenerateFlowParams): Promise<GenerateFlowResult> {
        const model = await resolveModel({ platformId, requestedModel, log })
        const tools = createPieceTools({ platformId, projectId, log })

        const submitFlow = tool({
            description: 'Submit the final workflow design. Call this exactly once, after you have inspected every piece you use.',
            inputSchema: FlowPlan,
        })

        const result = await generateText({
            model,
            system: GENERATE_SYSTEM_PROMPT + languageInstruction(locale),
            prompt,
            tools: { ...tools, submit_flow: submitFlow },
            stopWhen: stepCountIs(16),
        })

        const submitCall = findToolCall(result, 'submit_flow')
        if (isNil(submitCall)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: copilotMessage(locale, 'noWorkflow') },
            })
        }

        const plan = FlowPlan.parse(submitCall.input)
        const trigger = await buildTriggerTree({ plan, platformId, projectId, log })
        return { displayName: plan.displayName, trigger, schemaVersion: LATEST_FLOW_SCHEMA_VERSION }
    },

    async editFlow({ platformId, projectId, currentFlow, messages, model: requestedModel, locale }: EditFlowParams): Promise<EditFlowResult> {
        const model = await resolveModel({ platformId, requestedModel, log })
        const tools = createPieceTools({ platformId, projectId, log })

        const respond = tool({
            description: 'Respond to the user. Call this exactly once per turn with either a proposal, a question, or a plain message.',
            inputSchema: RespondInput,
        })

        const system = `${EDIT_SYSTEM_PROMPT}${languageInstruction(locale)}\n\nCURRENT FLOW:\n${describeFlow(currentFlow)}`
        const modelMessages: ModelMessage[] = messages.map((m) => ({
            role: m.role,
            content: m.content,
        }))

        const result = await generateText({
            model,
            system,
            messages: modelMessages,
            tools: { ...tools, respond },
            stopWhen: stepCountIs(16),
        })

        const respondCall = findToolCall(result, 'respond')
        if (isNil(respondCall)) {
            // Model answered in plain text without calling respond — treat text as a message.
            return { kind: 'message', message: result.text || copilotMessage(locale, 'cannotProcess') }
        }

        // Be lenient: models sometimes omit `message` or `kind`, so we coerce
        // rather than hard-fail on a strict schema parse.
        const safe = RespondInput.safeParse(respondCall.input ?? {})
        const raw = (safe.success ? safe.data : (respondCall.input ?? {})) as {
            kind?: string
            message?: string
            summary?: string
            changes?: string[]
            options?: Array<{ id: string, label: string }>
            flow?: unknown
        }

        const kind: 'proposal' | 'question' | 'message' =
            raw.kind === 'proposal' || raw.kind === 'question' || raw.kind === 'message'
                ? raw.kind
                : (!isNil(raw.flow) ? 'proposal' : (!isNil(raw.options) ? 'question' : 'message'))

        const message =
            typeof raw.message === 'string' && raw.message.length > 0
                ? raw.message
                : (raw.summary ?? result.text ?? '')

        if (kind === 'question') {
            return {
                kind: 'question',
                message: message || copilotMessage(locale, 'whichOption'),
                options: raw.options ?? [],
            }
        }

        if (kind === 'proposal') {
            const planResult = FlowPlan.safeParse(raw.flow)
            if (planResult.success) {
                const trigger = await buildTriggerTree({ plan: planResult.data, platformId, projectId, log })
                return {
                    kind: 'proposal',
                    message: message || copilotMessage(locale, 'proposalHeader'),
                    summary: raw.summary ?? (message || copilotMessage(locale, 'proposedChange')),
                    changes: raw.changes ?? [],
                    displayName: planResult.data.displayName,
                    trigger,
                    schemaVersion: LATEST_FLOW_SCHEMA_VERSION,
                }
            }
            return { kind: 'message', message: message || copilotMessage(locale, 'needMoreDetail') }
        }

        return { kind: 'message', message: message || copilotMessage(locale, 'cannotProcess') }
    },
})

type GenerateFlowParams = {
    platformId: string
    projectId: string
    prompt: string
    model?: string
    locale?: string
}

type EditFlowParams = {
    platformId: string
    projectId: string
    currentFlow: { displayName: string, trigger: unknown }
    messages: Array<{ role: 'user' | 'assistant', content: string }>
    model?: string
    locale?: string
}

async function resolveModel({ platformId, requestedModel, log }: {
    platformId: string
    requestedModel?: string
    log: FastifyBaseLogger
}): Promise<LanguageModel> {
    const providerConfig = await aiProviderService(log).getChatProvider({ platformId })
    if (isNil(providerConfig)) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'AIProvider',
                message: 'No AI provider is enabled for chat. Configure a provider under Settings → AI and enable it for chat before using the AI copilot.',
            },
        })
    }
    const modelId = requestedModel ?? DEFAULT_MODEL_BY_PROVIDER[providerConfig.provider]
    if (isNil(modelId)) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: { message: `No default model configured for provider ${providerConfig.provider}. Pass an explicit model.` },
        })
    }
    return chatAiUtils.createChatModel({
        provider: providerConfig.provider,
        auth: providerConfig.auth as Record<string, unknown>,
        config: providerConfig.config as Record<string, unknown>,
        modelId,
    })
}

function createPieceTools({ platformId, projectId, log }: {
    platformId: string
    projectId: string
    log: FastifyBaseLogger
}): ToolSet {
    const searchPieces = tool({
        description: 'Search the installed Activepieces catalog with 1-2 generic capability keywords (e.g. "date", "send email") — NOT brand names or full sentences. Returns matching pieces with their most relevant trigger and action names.',
        inputSchema: z.object({
            query: z.string().describe('A generic capability keyword, e.g. "date", "send email" or "google sheets". Avoid brand/company names and invented feature names.'),
        }),
        execute: async ({ query }) => {
            const runSearch = (searchQuery: string) => pieceMetadataService(log).list({
                platformId,
                projectId,
                searchQuery,
                suggestionType: SuggestionType.ACTION_AND_TRIGGER,
                includeHidden: false,
            })
            let pieces = await runSearch(query)
            // A whole-sentence / brand-name / invented-name query often matches
            // nothing under the strict fuzzy search. Fall back to searching each
            // meaningful word on its own and union the hits so a relevant piece
            // (and its suggested actions) still surfaces.
            if (pieces.length === 0) {
                const tokens = Array.from(new Set(
                    query.toLowerCase().split(/\s+/).filter((token) => token.length >= 3),
                ))
                const seen = new Set<string>()
                const unioned: Awaited<ReturnType<typeof runSearch>> = []
                for (const token of tokens) {
                    for (const piece of await runSearch(token)) {
                        if (!seen.has(piece.name)) {
                            seen.add(piece.name)
                            unioned.push(piece)
                        }
                    }
                }
                pieces = unioned
            }
            return pieces.slice(0, 8).map((piece) => ({
                pieceName: piece.name,
                displayName: piece.displayName,
                description: piece.description,
                triggers: (piece.suggestedTriggers ?? []).slice(0, 6).map((trig) => ({
                    name: trig.name,
                    displayName: trig.displayName,
                    description: trig.description,
                })),
                actions: (piece.suggestedActions ?? []).slice(0, 6).map((act) => ({
                    name: act.name,
                    displayName: act.displayName,
                    description: act.description,
                })),
            }))
        },
    })

    const getPieceDetails = tool({
        description: 'Return the full trigger/action list and their input parameters for a specific piece. Always call this before using a piece.',
        inputSchema: z.object({
            pieceName: z.string().describe('Exact piece name, e.g. "@activepieces/piece-gmail"'),
        }),
        execute: async ({ pieceName }) => {
            const meta = await pieceMetadataService(log).getOrThrow({ name: pieceName, platformId, projectId })
            return {
                pieceName: meta.name,
                pieceVersion: meta.version,
                triggers: Object.entries(meta.triggers).map(([name, trig]) => ({
                    name,
                    displayName: trig.displayName,
                    description: trig.description,
                    params: summarizeProps(trig.props),
                })),
                actions: Object.entries(meta.actions).map(([name, act]) => ({
                    name,
                    displayName: act.displayName,
                    description: act.description,
                    requiresConnection: act.requireAuth,
                    params: summarizeProps(act.props),
                })),
            }
        },
    })

    return { search_pieces: searchPieces, get_piece_details: getPieceDetails }
}

function findToolCall(
    result: { steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string, input: unknown }> }> },
    toolName: string,
): { input: unknown } | undefined {
    for (const step of result.steps) {
        for (const call of step.toolCalls) {
            if (call.toolName === toolName) {
                return { input: call.input }
            }
        }
    }
    return undefined
}

function describeFlow(currentFlow: { displayName: string, trigger: unknown }): string {
    const lines: string[] = [`Name: ${currentFlow.displayName}`]
    const trigger = currentFlow.trigger as FlowNode | undefined
    if (isNil(trigger)) {
        return lines.join('\n')
    }
    const settings = (trigger.settings ?? {}) as Record<string, unknown>
    if (trigger.type === FlowTriggerType.PIECE) {
        lines.push(`Trigger: ${trigger.displayName} [piece ${settings.pieceName} / ${settings.triggerName}] input=${safeJson(settings.input)}`)
    }
    else {
        lines.push(`Trigger: (not configured)`)
    }
    let node = trigger.nextAction
    let index = 1
    while (!isNil(node)) {
        const s = (node.settings ?? {}) as Record<string, unknown>
        if (node.type === FlowActionType.PIECE) {
            lines.push(`${node.name}: ${node.displayName} [piece ${s.pieceName} / ${s.actionName}] input=${safeJson(s.input)}`)
        }
        else {
            lines.push(`${node.name}: ${node.displayName} [${node.type}]`)
        }
        node = node.nextAction
        index++
    }
    return lines.join('\n')
}

type FlowNode = {
    name: string
    displayName: string
    type: string
    settings?: unknown
    nextAction?: FlowNode
}

function safeJson(value: unknown): string {
    try {
        const str = JSON.stringify(value ?? {})
        return str.length > 400 ? str.slice(0, 400) + '…' : str
    }
    catch {
        return '{}'
    }
}

function summarizeProps(props: Record<string, unknown> | undefined): Array<{ name: string, displayName: string, type: string, required: boolean, description?: string }> {
    if (isNil(props)) {
        return []
    }
    return Object.entries(props).map(([name, raw]) => {
        const prop = raw as { displayName?: string, type?: string, required?: boolean, description?: string }
        return {
            name,
            displayName: prop.displayName ?? name,
            type: String(prop.type ?? 'UNKNOWN'),
            required: prop.required ?? false,
            ...(prop.description ? { description: prop.description } : {}),
        }
    })
}

async function buildTriggerTree({ plan, platformId, projectId, log }: {
    plan: FlowPlan
    platformId: string
    projectId: string
    log: FastifyBaseLogger
}): Promise<FlowTrigger> {
    const now = new Date().toISOString()

    let nextAction: Record<string, unknown> | undefined = undefined
    for (let index = plan.steps.length - 1; index >= 0; index--) {
        const step = plan.steps[index]
        const meta = await safeGetPiece({ name: step.pieceName, platformId, projectId, log })
        const action = meta?.actions?.[step.actionName]
        const cleanedInput = pickKnownKeys(step.input, action?.props)
        const requiredMissing = hasMissingRequired(action?.props, cleanedInput)
        const requiresConnection = action?.requireAuth === true

        const actionNode: Record<string, unknown> = {
            name: `step_${index + 1}`,
            type: FlowActionType.PIECE,
            displayName: step.displayName || action?.displayName || step.actionName,
            valid: !isNil(meta) && !isNil(action) && !requiredMissing && !requiresConnection,
            lastUpdatedDate: now,
            settings: {
                pieceName: step.pieceName,
                pieceVersion: meta?.version ?? '0.0.0',
                actionName: step.actionName,
                input: cleanedInput,
                propertySettings: {},
                errorHandlingOptions: {
                    continueOnFailure: { value: false },
                    retryOnFailure: { value: false },
                },
            },
            ...(nextAction ? { nextAction } : {}),
        }
        nextAction = actionNode
    }

    const triggerMeta = await safeGetPiece({ name: plan.trigger.pieceName, platformId, projectId, log })
    const triggerDef = triggerMeta?.triggers?.[plan.trigger.triggerName]

    if (isNil(triggerMeta) || isNil(triggerDef)) {
        return {
            name: 'trigger',
            type: FlowTriggerType.EMPTY,
            displayName: plan.trigger.displayName || 'Select Trigger',
            valid: false,
            lastUpdatedDate: now,
            settings: {},
            ...(nextAction ? { nextAction } : {}),
        } as unknown as FlowTrigger
    }

    const triggerInput = pickKnownKeys(plan.trigger.input, triggerDef.props)
    const triggerValid = !hasMissingRequired(triggerDef.props, triggerInput)

    return {
        name: 'trigger',
        type: FlowTriggerType.PIECE,
        displayName: plan.trigger.displayName || triggerDef.displayName || plan.trigger.triggerName,
        valid: triggerValid,
        lastUpdatedDate: now,
        settings: {
            pieceName: plan.trigger.pieceName,
            pieceVersion: triggerMeta.version,
            triggerName: plan.trigger.triggerName,
            input: triggerInput,
            propertySettings: {},
        },
        ...(nextAction ? { nextAction } : {}),
    } as unknown as FlowTrigger
}

type ResolvedPiece = {
    version: string
    actions: Record<string, { displayName: string, props?: Record<string, unknown>, requireAuth?: boolean }>
    triggers: Record<string, { displayName: string, props?: Record<string, unknown> }>
}

async function safeGetPiece({ name, platformId, projectId, log }: {
    name: string
    platformId: string
    projectId: string
    log: FastifyBaseLogger
}): Promise<ResolvedPiece | undefined> {
    try {
        const meta = await pieceMetadataService(log).getOrThrow({ name, platformId, projectId })
        return meta as unknown as ResolvedPiece
    }
    catch (error) {
        log.warn({ err: error, pieceName: name }, '[copilot] failed to resolve piece, leaving step invalid')
        return undefined
    }
}

function pickKnownKeys(input: Record<string, unknown>, props: Record<string, unknown> | undefined): Record<string, unknown> {
    if (isNil(props)) {
        return { ...input }
    }
    const known: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
        if (key in props) {
            known[key] = value
        }
    }
    return known
}

function hasMissingRequired(props: Record<string, unknown> | undefined, input: Record<string, unknown>): boolean {
    if (isNil(props)) {
        return false
    }
    for (const [key, raw] of Object.entries(props)) {
        const prop = raw as { required?: boolean }
        if (prop.required === true && (isNil(input[key]) || input[key] === '')) {
            return true
        }
    }
    return false
}
