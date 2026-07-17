import { Flow, Platform, Project } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type CopilotConversation = {
    id: string
    created: string
    updated: string
    platformId: string
    projectId: string
    flowId: string
    messages: object[]
}

type CopilotConversationWithRelations = CopilotConversation & {
    platform: Platform
    project: Project
    flow: Flow
}

export const CopilotConversationEntity = new EntitySchema<CopilotConversationWithRelations>({
    name: 'copilot_conversation',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        projectId: {
            ...ApIdSchema,
            nullable: false,
        },
        flowId: {
            ...ApIdSchema,
            nullable: false,
        },
        messages: {
            type: 'jsonb',
            nullable: false,
            default: '[]',
        },
    },
    indices: [
        {
            name: 'idx_copilot_conversation_flow_id',
            columns: ['flowId'],
            unique: true,
        },
    ],
    relations: {
        platform: {
            type: 'many-to-one',
            target: 'platform',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_copilot_conversation_platform_id',
            },
        },
        project: {
            type: 'many-to-one',
            target: 'project',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_copilot_conversation_project_id',
            },
        },
        flow: {
            type: 'many-to-one',
            target: 'flow',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'flowId',
                foreignKeyConstraintName: 'fk_copilot_conversation_flow_id',
            },
        },
    },
})
