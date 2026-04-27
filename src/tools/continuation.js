/**
 * Drives the dispatch → continuation → continue loop on the plugin side.
 *
 * The backend handler may yield N continuations (read_local_file, etc.); this
 * module executes each locally with the supplied allowlist and POSTs the
 * result back via `api.continueTool`. Returns the terminal `{ok, ...}` object.
 */

import {
  readLocalFile,
  writeLocalFile,
  listLocalDir,
  uploadLocalFileToConversation,
} from './local-primitives.js';

export const MAX_CONTINUATION_DEPTH = 10;

async function executeContinuation(c, ctx) {
  const { allowedPrefixes, api } = ctx;
  switch (c.type) {
    case 'read_local_file':
      return readLocalFile(c.path, allowedPrefixes);
    case 'write_local_file':
      return writeLocalFile(c.path, c.content_b64, allowedPrefixes);
    case 'list_local_dir':
      return listLocalDir(c.path, allowedPrefixes);
    case 'upload_local_file_to_conversation':
      return uploadLocalFileToConversation(
        c.path, c.conversation_id, api, allowedPrefixes,
      );
    default: {
      const err = new Error(`unknown_continuation_type: ${c.type}`);
      err.code = 'unknown_continuation_type';
      throw err;
    }
  }
}

export async function runContinuationLoop(api, dispatchResp, ctx) {
  const { log } = ctx;
  let resp = dispatchResp;
  let depth = 0;

  while (resp && resp.continuation) {
    if (++depth > MAX_CONTINUATION_DEPTH) {
      log?.error?.(`[KK-T010] continuation loop exceeded ${MAX_CONTINUATION_DEPTH}`);
      return {
        ok: false,
        error: 'continuation_loop_too_deep',
        hint: 'Internal protocol error; the tool call did not complete.',
      };
    }

    const c = resp.continuation;
    log?.debug?.(`[KK-T003] continuation type=${c.type} id=${c.id} depth=${depth}`);

    let result;
    try {
      result = await executeContinuation(c, { ...ctx, api });
    } catch (err) {
      const code = err.code || 'continuation_error';
      log?.warn?.(`[KK-T012] continuation ${c.type} failed (${code}): ${err.message}`);
      // Send the failure back to backend so it can decide whether to terminate
      // or recover. Backend will typically wrap it in a terminal {ok:false,...}.
      result = { ok: false, error: code, message: err.message };
    }

    try {
      resp = await api.continueTool(c.id, result);
    } catch (err) {
      log?.error?.(`[KK-T013] continue request failed: ${err.message}`);
      return {
        ok: false,
        error: err.code || 'backend_unavailable',
        hint: err.message,
      };
    }
  }

  log?.info?.(
    `[KK-T004] terminal ${resp?.ok === false ? `error=${resp.error}` : 'ok'}`,
  );
  return resp;
}
