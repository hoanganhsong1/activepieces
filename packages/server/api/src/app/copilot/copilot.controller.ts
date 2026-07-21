import { PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { FlowEntity } from '../flows/flow/flow.entity'
import { copilotConversationService } from './copilot-conversation.service'
import { copilotFlowGenerator } from './copilot-flow-generator'

// Resolve the project (and authorize access) from the flow referenced by the
// :flowId route param. This populates request.projectId — user principals do
// NOT carry a projectId, so we must derive it from the flow.
const flowProjectSecurity = securityAccess.project(
    [PrincipalType.USER],
    undefined,
    {
        type: ProjectResourceType.TABLE,
        tableName: FlowEntity,
        lookup: { paramKey: 'flowId', entityField: 'id' },
    },
)

export const copilotController: FastifyPluginAsyncZod = async (app) => {
    app.post('/generate-flow', GenerateFlowOptions, async (request) => {
        const platformId = request.principal.platform.id
        // generate-flow has no flow yet; piece search is platform-scoped.
        const projectId = (request.principal as unknown as { projectId?: string }).projectId ?? ''
        return copilotFlowGenerator(app.log).generateFlow({
            platformId,
            projectId,
            prompt: request.body.prompt,
            model: request.body.model,
            locale: request.body.locale,
        })
    })

    app.post('/edit-flow', EditFlowOptions, async (request) => {
        const platformId = request.principal.platform.id
        const projectId = (request.principal as unknown as { projectId?: string }).projectId ?? ''
        return copilotFlowGenerator(app.log).editFlow({
            platformId,
            projectId,
            currentFlow: request.body.currentFlow,
            messages: request.body.messages,
            model: request.body.model,
            locale: request.body.locale,
        })
    })

    app.get(
        '/conversations/:flowId',
        {
            config: { security: flowProjectSecurity },
            schema: {
                tags: ['copilot'],
                description: 'Load the saved copilot conversation for a flow',
                params: z.object({ flowId: z.string() }),
            },
        },
        async (request) => {
            const messages = await copilotConversationService(app.log).getMessages({
                projectId: request.projectId,
                flowId: request.params.flowId,
            })
            return { messages }
        },
    )

    app.post(
        '/conversations/:flowId',
        {
            config: { security: flowProjectSecurity },
            schema: {
                tags: ['copilot'],
                description: 'Persist the copilot conversation for a flow',
                params: z.object({ flowId: z.string() }),
                body: z.object({ messages: z.array(z.any()).max(500) }),
            },
        },
        async (request, reply) => {
            await copilotConversationService(app.log).saveMessages({
                platformId: request.principal.platform.id,
                projectId: request.projectId,
                flowId: request.params.flowId,
                messages: request.body.messages,
            })
            return reply.status(StatusCodes.NO_CONTENT).send()
        },
    )
}

const GenerateFlowRequest = z.object({
    prompt: z.string().min(1).max(4000),
    model: z.string().optional(),
    locale: z.string().optional(),
})

const GenerateFlowOptions = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
    },
    schema: {
        tags: ['copilot'],
        description: 'Generate a workflow design from a natural-language prompt',
        body: GenerateFlowRequest,
    },
}

const EditFlowRequest = z.object({
    currentFlow: z.object({
        displayName: z.string(),
        trigger: z.any(),
    }),
    messages: z
        .array(
            z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string(),
            }),
        )
        .min(1)
        .max(60),
    model: z.string().optional(),
    locale: z.string().optional(),
})

const EditFlowOptions = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
    },
    schema: {
        tags: ['copilot'],
        description: 'Edit an existing flow conversationally; returns a proposal or a clarifying question',
        body: EditFlowRequest,
    },
}
