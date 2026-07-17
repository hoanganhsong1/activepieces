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
    [AIProviderName.ANTHROPIC]: 'claude-3-7-sonnet-latest',
    [AIProviderName.GOOGLE]: 'gemini-2.0-flash',
    [AIProviderName.AZURE]: 'gpt-4o',
    [AIProviderName.BEDROCK]: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    [AIProviderName.MISTRAL]: 'mistral-large-latest',
    [AIProviderName.OPENROUTER]: 'openai/gpt-4o',
    [AIProviderName.ACTIVEPIECES]: 'openai/gpt-4o',
    [AIProviderName.CLOUDFLARE_GATEWAY]: 'gpt-4o',
    [AIProviderName.CUSTOM]: 'gpt-4o',
}

const PROCESS_RULES = `Process — follow it strictly:
1. Call "search_pieces" one or more times to discover pieces whose triggers/actions match the capabilities needed. Use short capability phrases (e.g. "schedule", "send email", "google sheets", "http request").
2. Call "get_piece_details" for every piece you intend to use, to read the exact trigger/action names and their input parameters. NEVER invent a pieceName, triggerName, actionName or input key — only use values returned by the tools.

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
    async generateFlow({ platformId, projectId, prompt, model: requestedModel }: GenerateFlowParams): Promise<GenerateFlowResult> {
        const model = await resolveModel({ platformId, requestedModel, log })
        const tools = createPieceTools({ platformId, projectId, log })

        const submitFlow = tool({
            description: 'Submit the final workflow design. Call this exactly once, after you have inspected every piece you use.',
            inputSchema: FlowPlan,
        })

        const result = await generateText({
            model,
            system: GENERATE_SYSTEM_PROMPT,
            prompt,
            tools: { ...tools, submit_flow: submitFlow },
            stopWhen: stepCountIs(16),
        })

        const submitCall = findToolCall(result, 'submit_flow')
        if (isNil(submitCall)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: 'The AI did not produce a workflow. Try rephrasing your request with more detail.' },
            })
        }

        const plan = FlowPlan.parse(submitCall.input)
        const trigger = await buildTriggerTree({ plan, platformId, projectId, log })
        return { displayName: plan.displayName, trigger, schemaVersion: LATEST_FLOW_SCHEMA_VERSION }
    },

    async editFlow({ platformId, projectId, currentFlow, messages, model: requestedModel }: EditFlowParams): Promise<EditFlowResult> {
        const model = await resolveModel({ platformId, requestedModel, log })
        const tools = createPieceTools({ platformId, projectId, log })

        const respond = tool({
            description: 'Respond to the user. Call this exactly once per turn with either a proposal, a question, or a plain message.',
            inputSchema: RespondInput,
        })

        const system = `${EDIT_SYSTEM_PROMPT}\n\nCURRENT FLOW:\n${describeFlow(currentFlow)}`
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
            return { kind: 'message', message: result.text || 'I could not process that request. Please try again.' }
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
                message: message || 'Which option would you like?',
                options: raw.options ?? [],
            }
        }

        if (kind === 'proposal') {
            const planResult = FlowPlan.safeParse(raw.flow)
            if (planResult.success) {
                const trigger = await buildTriggerTree({ plan: planResult.data, platformId, projectId, log })
                return {
                    kind: 'proposal',
                    message: message || 'Here is the proposed change.',
                    summary: raw.summary ?? (message || 'Proposed change'),
                    changes: raw.changes ?? [],
                    displayName: planResult.data.displayName,
                    trigger,
                    schemaVersion: LATEST_FLOW_SCHEMA_VERSION,
                }
            }
            return { kind: 'message', message: message || 'I need a bit more detail to change the flow.' }
        }

        return { kind: 'message', message: message || 'I could not process that request. Please try again.' }
    },
})

type GenerateFlowParams = {
    platformId: string
    projectId: string
    prompt: string
    model?: string
}

type EditFlowParams = {
    platformId: string
    projectId: string
    currentFlow: { displayName: string, trigger: unknown }
    messages: Array<{ role: 'user' | 'assistant', content: string }>
    model?: string
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
        description: 'Search the installed Activepieces catalog. Returns pieces whose triggers/actions match the query, with their most relevant trigger and action names.',
        inputSchema: z.object({
            query: z.string().describe('A capability to search for, e.g. "send email" or "google sheets"'),
        }),
        execute: async ({ query }) => {
            const pieces = await pieceMetadataService(log).list({
                platformId,
                projectId,
                searchQuery: query,
                suggestionType: SuggestionType.ACTION_AND_TRIGGER,
                includeHidden: false,
            })
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
