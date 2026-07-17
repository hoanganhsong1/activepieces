import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddCopilotConversationTable1810000000000 implements Migration {
    name = 'AddCopilotConversationTable1810000000000'
    breaking = false
    release = '0.86.3'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "copilot_conversation" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "flowId" character varying(21) NOT NULL,
                "messages" jsonb NOT NULL DEFAULT '[]',
                CONSTRAINT "pk_copilot_conversation" PRIMARY KEY ("id"),
                CONSTRAINT "fk_copilot_conversation_platform_id" FOREIGN KEY ("platformId")
                    REFERENCES "platform"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_copilot_conversation_project_id" FOREIGN KEY ("projectId")
                    REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_copilot_conversation_flow_id" FOREIGN KEY ("flowId")
                    REFERENCES "flow"("id") ON DELETE CASCADE
            )
        `)

        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "idx_copilot_conversation_flow_id"
            ON "copilot_conversation" ("flowId")
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP INDEX IF EXISTS "idx_copilot_conversation_flow_id"')
        await queryRunner.query('DROP TABLE IF EXISTS "copilot_conversation"')
    }
}
