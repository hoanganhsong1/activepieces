import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { copilotController } from './copilot.controller'

export const copilotModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(copilotController, { prefix: '/v1/copilot' })
}
