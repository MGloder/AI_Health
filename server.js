import Fastify from "fastify";
import FastifyVite from "@fastify/vite";
import fastifyEnv from "@fastify/env";
import FastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { Agent, ProxyAgent } from "undici";
import pino from 'pino';
import { generateInstructions } from './instructionConfig.js';

// Configure logger
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  },
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize proxy agent
const dispatcher = process.env.NODE_ENV === 'development' && process.env.ALL_PROXY
  ? new ProxyAgent({
      uri: process.env.ALL_PROXY
    })
  : new Agent();

logger.debug({
  msg: 'Proxy agent initialized',
  mode: process.env.NODE_ENV,
  proxy: process.env.ALL_PROXY || 'none'
});

// Fastify + React + Vite configuration
const server = Fastify({
  logger: logger
});
logger.info('Fastify server created');

const schema = {
  type: "object",
  required: ["OPENAI_API_KEY"],
  properties: {
    OPENAI_API_KEY: {
      type: "string",
    },
  },
};

// Register plugins with logging
logger.debug('Registering static files plugin...');
await server.register(FastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/public/",
  decorateReply: false,
});
logger.debug('Static files plugin registered');

logger.debug('Registering env plugin...');
await server.register(fastifyEnv, { dotenv: true, schema });
logger.debug('Env plugin registered');

logger.debug('Registering Vite plugin...');
await server.register(FastifyVite, {
  root: import.meta.url,
  renderer: "@fastify/react",
  dev: process.env.NODE_ENV !== "production",
});
logger.debug('Vite plugin registered');

await server.vite.ready();
logger.info('Vite is ready');

server.get("/api-env", async (request, reply) => {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
  };
});

// Server-side API route to return an ephemeral realtime session token
server.get("/token", async (request, reply) => {
  logger.info('Token request received');
  try {
    logger.debug('Generating instructions...');
    const config = await generateInstructions();
    
    logger.debug('Making request to OpenAI...');
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      dispatcher,
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    });

    const responseClone = r.clone();
    const bodyText = await responseClone.text();
    logger.debug('Response received:', {
      status: r.status,
      headers: Object.fromEntries(r.headers.entries()),
      body: bodyText
    });

    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error in token endpoint');
    throw error;
  }
});

// Server startup with logging
try {
  await server.listen({
    port: process.env.PORT || 3000,
    host: "0.0.0.0",
  });
  logger.info(`Server is running on port ${process.env.PORT || 3000}`);
} catch (err) {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
}
