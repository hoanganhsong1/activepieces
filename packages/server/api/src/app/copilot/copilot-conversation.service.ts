import { apId } from '@activepieces/core-utils'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../core/db/repo-factory'
import { CopilotConversationEntity } from './copilot-conversation-entity'

const copilotConversationRepo = repoFactory(CopilotConversationEntity)

export const copilotConversationService = (_log: FastifyBaseLogger) => ({
    async getMessages({ projectId, flowId }: { projectId: string, flowId: string }): Promise<object[]> {
        const conversation = await copilotConversationRepo().findOneBy({ projectId, flowId })
        return conversation?.messages ?? []
    },

    async saveMessages({ platformId, projectId, flowId, messages }: {
        platformId: string
        projectId: string
        flowId: string
        messages: object[]
    }): Promise<void> {
        const repo = copilotConversationRepo()
        // Update-first, insert-if-missing. Errors propagate (surface as 500 +
        // client toast) instead of being swallowed — a swallowed insert error
        // is what previously hid the missing-projectId bug.
        const existing = await repo.findOneBy({ flowId })
        if (existing) {
            await repo.update({ flowId }, { messages })
            return
        }
        await repo.save({
            id: apId(),
            platformId,
            projectId,
            flowId,
            messages,
        })
    },
})
