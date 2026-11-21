#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT_DIR = process.cwd();
const SCHEMA_PATH = path.join(ROOT_DIR, 'protocol', 'castora-protocol.schema.json');
const VALID_DIR = path.join(ROOT_DIR, 'protocol', 'fixtures', 'valid');
const INVALID_DIR = path.join(ROOT_DIR, 'protocol', 'fixtures', 'invalid');

// Map each invalid fixture filename to the schema keyword or path substring we expect to see in its error
const EXPECTED_INVALID_PATTERNS = {
  'invalid-unsupported-version.json': '/protocolVersion',
  'invalid-unknown-message-type.json': '/messageType',
  'invalid-missing-sender-device-id.json': "must have required property 'senderDeviceId'",
  'invalid-timestamp-format.json': '/timestamp',
  'invalid-room-id-pattern.json': '/roomId',
  'invalid-device-announce-port-type.json': '/payload/wsPort',
  'invalid-device-discover-role.json': '/payload/requestedRole',
  'invalid-pair-request-short-nonce.json': '/payload/ephemeralNonce',
  'invalid-pair-response-null-receiver.json': '/receiverDeviceId',
  'invalid-connection-request-missing-quality.json': "must have required property 'requestedQuality'",
  'invalid-connection-accepted-slot-negative.json': '/payload/assignedSlotIndex',
  'invalid-connection-rejected-reason-code.json': '/payload/reasonCode',
  'invalid-session-offer-wrong-sdp-type.json': '/payload/sdpType',
  'invalid-session-answer-empty-sdp.json': '/payload/sdp',
  'invalid-ice-candidate-negative-mline.json': '/payload/sdpMLineIndex',
  'invalid-stream-start-zero-fps.json': '/payload/fps',
  'invalid-stream-stop-unknown-reason.json': '/payload/reason',
  'invalid-stream-status-extra-property.json': 'must NOT have additional properties',
  'invalid-disconnect-missing-reason.json': "must have required property 'reason'",
  'invalid-error-unknown-code.json': '/payload/code',
  'invalid-heartbeat-negative-sequence.json': '/payload/sequence',
};

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function formatErrors(errors = []) {
  return errors
    .map((err) => {
      const location = err.instancePath || '(root)';
      const params = err.params ? JSON.stringify(err.params) : '';
      return `${location} ${err.message} ${params}`.trim();
    })
    .join(' | ');
}

function main() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`FAIL: Schema file not found at ${SCHEMA_PATH}`);
    process.exit(1);
  }

  let schema;
  try {
    schema = readJsonFile(SCHEMA_PATH);
  } catch (err) {
    console.error(`FAIL: Could not parse schema JSON: ${err.message}`);
    process.exit(1);
  }

  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  });
  addFormats(ajv);

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    console.error(`FAIL: Schema compilation failed: ${err.message}`);
    process.exit(1);
  }

  const validFiles = fs.existsSync(VALID_DIR)
    ? fs.readdirSync(VALID_DIR).filter((f) => f.endsWith('.json')).sort()
    : [];
  const invalidFiles = fs.existsSync(INVALID_DIR)
    ? fs.readdirSync(INVALID_DIR).filter((f) => f.endsWith('.json')).sort()
    : [];

  if (validFiles.length === 0 || invalidFiles.length === 0) {
    console.error('FAIL: Both protocol/fixtures/valid and protocol/fixtures/invalid must contain .json fixtures.');
    process.exit(1);
  }

  let failures = 0;

  console.log(`\nValidating ${validFiles.length} valid fixtures against castora-protocol.schema.json...`);
  for (const file of validFiles) {
    const filePath = path.join(VALID_DIR, file);
    let data;
    try {
      data = readJsonFile(filePath);
    } catch (err) {
      console.error(`  [FAIL] valid/${file} — Invalid JSON syntax: ${err.message}`);
      failures += 1;
      continue;
    }

    const ok = validate(data);
    if (!ok) {
      console.error(`  [FAIL] valid/${file} — Expected PASS, got errors: ${formatErrors(validate.errors)}`);
      failures += 1;
    } else {
      console.log(`  [PASS] valid/${file} (${data.messageType})`);
    }
  }

  console.log(`\nValidating ${invalidFiles.length} invalid fixtures (must fail for expected reason)...`);
  for (const file of invalidFiles) {
    const filePath = path.join(INVALID_DIR, file);
    let data;
    try {
      data = readJsonFile(filePath);
    } catch (err) {
      console.error(`  [FAIL] invalid/${file} — Invalid JSON syntax: ${err.message}`);
      failures += 1;
      continue;
    }

    const ok = validate(data);
    if (ok) {
      console.error(`  [FAIL] invalid/${file} — Expected FAIL, but passed schema validation!`);
      failures += 1;
      continue;
    }

    const errorSummary = formatErrors(validate.errors);
    const expectedPattern = EXPECTED_INVALID_PATTERNS[file];
    if (expectedPattern && !errorSummary.includes(expectedPattern)) {
      console.error(
        `  [FAIL] invalid/${file} — Failed for unexpected reason.\n` +
          `         Expected substring: "${expectedPattern}"\n` +
          `         Actual errors: ${errorSummary}`
      );
      failures += 1;
    } else {
      console.log(`  [PASS] invalid/${file} — Rejected as expected (${errorSummary})`);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Valid fixtures tested:   ${validFiles.length}`);
  console.log(`Invalid fixtures tested: ${invalidFiles.length}`);
  console.log(`Failures:                ${failures}`);

  if (failures > 0) {
    process.exit(1);
  }
}

main();
