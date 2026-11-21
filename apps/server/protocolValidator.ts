import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { generateMessageId } from './security.ts';

export type CastoraErrorCode =
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_MESSAGE'
  | 'INVALID_NONCE'
  | 'INVALID_ROOM_ID'
  | 'APPROVAL_DECLINED'
  | 'SESSION_FULL'
  | 'CAPTURE_PERMISSION_DENIED'
  | 'WEBRTC_NEGOTIATION_FAILED'
  | 'INTERNAL_ERROR';

export interface CastoraEnvelope<TPayload = Record<string, unknown>> {
  protocolVersion: 'castora.v1';
  messageType: string;
  messageId: string;
  senderDeviceId: string;
  receiverDeviceId: string | null;
  roomId: string | null;
  timestamp: string;
  payload: TPayload;
}

export type ValidationResult =
  | { valid: true; envelope: CastoraEnvelope }
  | { valid: false; errorCode: CastoraErrorCode; summary: string };

const SCHEMA_PATH = path.resolve(process.cwd(), 'protocol', 'castora-protocol.schema.json');

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) {
    return cachedValidator;
  }
  const rawSchema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const schema = JSON.parse(rawSchema) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

function summarizeErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'Message failed castora.v1 schema validation';
  }
  const first = errors[0];
  const loc = first.instancePath || '(root)';
  return `${loc} ${first.message ?? 'is invalid'}`.slice(0, 240);
}

export function validateCastoraEnvelope(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      errorCode: 'INVALID_MESSAGE',
      summary: 'Signaling message must be a JSON object',
    };
  }

  const validate = getValidator();
  const ok = validate(input);
  if (ok) {
    return {
      valid: true,
      envelope: input as CastoraEnvelope,
    };
  }

  const errors = validate.errors ?? [];
  const hasVersionError = errors.some((err) => err.instancePath === '/protocolVersion');
  const hasRoomError = errors.some((err) => err.instancePath === '/roomId');

  return {
    valid: false,
    errorCode: hasVersionError
      ? 'UNSUPPORTED_VERSION'
      : hasRoomError
        ? 'INVALID_ROOM_ID'
        : 'INVALID_MESSAGE',
    summary: summarizeErrors(errors),
  };
}

export function createServerEnvelope<TPayload extends Record<string, unknown>>(params: {
  messageType: string;
  receiverDeviceId: string | null;
  roomId: string | null;
  payload: TPayload;
  senderDeviceId?: string;
}): CastoraEnvelope<TPayload> {
  return {
    protocolVersion: 'castora.v1',
    messageType: params.messageType,
    messageId: generateMessageId('srv'),
    senderDeviceId: params.senderDeviceId ?? 'castora-server',
    receiverDeviceId: params.receiverDeviceId,
    roomId: params.roomId,
    timestamp: new Date().toISOString(),
    payload: params.payload,
  };
}

export function createErrorEnvelope(params: {
  receiverDeviceId: string | null;
  roomId: string | null;
  code: CastoraErrorCode;
  message: string;
  recoverable: boolean;
  relatedMessageId: string | null;
}): CastoraEnvelope {
  return createServerEnvelope({
    messageType: 'error',
    receiverDeviceId: params.receiverDeviceId,
    roomId: params.roomId,
    payload: {
      code: params.code,
      message: params.message.slice(0, 256) || 'Signaling error',
      recoverable: params.recoverable,
      relatedMessageId: params.relatedMessageId,
    },
  });
}
