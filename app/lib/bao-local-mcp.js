#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { uploadBaoImages, uploadBaoFiles, uploadBaoToCanvas, patchBaoCanvas, wireBaoCanvasVideos, inspectBaoVideoInputs, setBaoCanvasText, inspectBaoCanvas, repairBaoCanvasBindings, uploadBaoWebtoon } = require('./bao-upload');
const { baoEditorServices } = require('./bao-editor-services');

const root = path.resolve(__dirname, '..', '..');
const data = path.join(root, 'data');
const tool = {
  name: 'bao_upload_images',
  description: 'Upload Flash Studio /files/images/... or /files/uploads/... PNG/JPEG files to an exact BAO project. Calculates actual size and SHA256, obtains BAO MCP upload tickets, sends the binaries, and returns saved asset IDs. Use production_projects to select project_id. For canvas placement, follow with BAO production_capabilities canvas.patch and attach_media using the returned assetId. This tool does not generate or render media.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['project_id', 'images'],
    properties: {
      project_id: { type: 'string', description: 'Exact ID from BAO production_projects' },
      images: { type: 'array', minItems: 1, maxItems: 64, items: {
        type: 'object', additionalProperties: false, required: ['path'], properties: {
          path: { type: 'string', description: 'Flash image URL path' },
          alias: { type: 'string' }, name: { type: 'string' },
          category: { type: 'string', enum: ['character', 'background', 'equipment', 'other'] },
          description: { type: 'string' }
        }
      } }
    }
  }
};
const fileTool = {
  name: 'bao_upload_files',
  description: 'Upload exact Flash Studio local PNG/JPEG/WebP image, MP3 audio, MP4/MOV/WebM video, JSON draft, or TXT/MD draft files into an exact BAO project asset library. Calculates size/SHA256, obtains MCP upload tickets and transfers bytes. Returns asset IDs for BAO workflows. Use production_projects first. This does not generate or render media.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['project_id', 'files'],
    properties: { project_id: { type: 'string' },
      files: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false,
        required: ['path'], properties: { path: { type: 'string' }, alias: { type: 'string' }, name: { type: 'string' },
          category: { type: 'string', enum: ['character', 'background', 'equipment', 'audio', 'other'] }, description: { type: 'string' } } } }
    }
  }
};
const canvasTool = {
  name: 'bao_upload_to_canvas',
  description: 'DIRECT: Upload 1–20 Flash Studio local PNG/JPEG images AND place each as a saved image node in one exact BAO free canvas, vertically in input order. This tool reads local file bytes, calculates SHA256 and size, transfers binaries with BAO upload tickets, then uses canvas.patch with revision CAS. Use canvas_overview/read_canvas_graph first for graph_id and base_revision. It does not generate or render media. If placement fails, the returned asset IDs remain saved; do not upload again.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['project_id', 'graph_id', 'base_revision', 'images'],
    properties: { ...tool.inputSchema.properties,
      graph_id: { type: 'string', description: 'Exact graph ID from canvas_overview' },
      base_revision: { type: 'integer', minimum: 0, description: 'Current saved graph revision' },
      images: { ...tool.inputSchema.properties.images, maxItems: 20 }
    }
  }
};
const patchTool = {
  name: 'bao_canvas_patch',
  description: 'DIRECT BAO free-canvas editor. Use after read_canvas_graph detail=full: apply 1–20 exact changes with current revision CAS and read back. update_node uses {kind:"update_node",nodeId:"existing ID",position:{x,y}} or prompt/title/config; add_node uses {kind:"add_node",node:{id:"new ID",type:"text.input",position:{x,y},config:{title:"Cut",text:"prompt"}}}; config belongs INSIDE node, and text.input must not set contentType. attach_media uses existing assetId as attachmentKey with mode add|replace. Never use op/id for update_node. This tool prepares and executes the authorized edit and never generates images/video. Preserve untouched nodes/links.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['project_id', 'graph_id', 'base_revision', 'changes'],
    properties: {
      project_id: { type: 'string' }, graph_id: { type: 'string' }, base_revision: { type: 'integer', minimum: 0 },
      changes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['kind'],
        properties: { kind: { type: 'string', enum: ['update_node', 'add_node', 'remove_node', 'add_edge', 'update_edge', 'remove_edge', 'upsert_group', 'remove_group', 'attach_media', 'replace_media'] },
          nodeId: { type: 'string' }, position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
          prompt: { type: 'string' }, title: { type: 'string' }, config: { type: 'object' }, node: { type: 'object' },
          edge: { type: 'object' }, edgeId: { type: 'string' }, group: { type: 'object' }, groupId: { type: 'string' },
          attachmentKey: { type: 'string' }, mode: { type: 'string', enum: ['add', 'replace'] }, sourceNodeId: { type: 'string' } },
        additionalProperties: false } }
    } }
};
const wireVideoTool = {
  name: 'bao_canvas_wire_video_batch',
  description: 'DIRECT Flash canvas setup, NO GENERATION: For 1–40 explicit cut pairs, query BAO canvas_node_catalog for real video.generate ports and WAN 3.0 MuleRouter 480p config; read the saved graph, create one video node per cut with the per-cut duration from script_sheet (required, no fixed 5s) and synchronized audio ON (generateAudio true unless generate_audio=false; existing nodes are updated to match), connect that cut’s PRO image to images and its text prompt to prompt, then read back every node, edge and the audio setting. Handles 20-change CAS batches and preserves all existing nodes/media. Does not call a provider or spend credits. Existing text may be an image-edit prompt, so review it before later video generation.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['project_id', 'graph_id', 'pairs'],
    properties: {
      project_id: { type: 'string' }, graph_id: { type: 'string' },
      expected_revision: { type: 'integer', minimum: 0 },
      pairs: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false,
        required: ['pro_image_node_id', 'prompt_node_id', 'duration'], properties: {
          pro_image_node_id: { type: 'string' }, prompt_node_id: { type: 'string' },
          video_node_id: { type: 'string' }, title: { type: 'string' },
          duration: { type: 'integer', minimum: 2, maximum: 30, description: '영상 길이(초). script_sheet 가 컷마다 계산한 값을 넣는다. 고정 5초 금지' }
        } } },
      generate_audio: { type: 'boolean', description: '동기화 오디오(대사·효과음) 생성. 기본 true. 이미 있는 영상 노드도 이 값으로 맞춘다' }
    }
  }
};
const videoInputsTool = {
  name: 'bao_canvas_video_inputs',
  description: 'READ ONLY, DIRECT Flash diagnosis: inspect the latest saved BAO canvas without asking for a revision or individual node IDs. Show reference slots sorted by edge.order and actual prompt sources. For structured REFERENCE-TO-VIDEO prompts, validate SHOT windows/durations, Total=config.duration, ratio, global dialogue windows, continuation start SHOT, duplicate utterances/edges and Image/Audio tokens. Correct structural errors before generation; structure success does not verify provider image role or rendered output. Never duplicate confirmed connections. No generation or edit.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['project_id', 'graph_id'], properties: {
      project_id: { type: 'string' }, graph_id: { type: 'string' }
    }
  }
};
const textTool = {
  name: 'bao_canvas_set_text',
  description: 'Save ONE cut-specific prompt as a BAO free-canvas text.input node using sparse config merge and latest revision. Existing structured REFERENCE-TO-VIDEO prompts are checked against connected video duration, ratio, SHOT windows and reference slots before saving; structural errors are rejected before prepare/execute. Preserve all authored dialogue and existing performance content. After save, reread the actual title/text/position. Saved verification is not rendered-output verification. No image/video generation.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['project_id', 'graph_id', 'node_id', 'title', 'text'],
    properties: {
      project_id: { type: 'string' }, graph_id: { type: 'string' },
      base_revision: { type: 'integer', minimum: 0, description: 'Optional; the latest revision is read automatically' },
      node_id: { type: 'string' },
      title: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 12000 },
      mode: { type: 'string', enum: ['add', 'update'], description: 'Optional hint only; existence is checked automatically' },
      x: { type: 'number' }, y: { type: 'number' }
    }
  }
};
const inspectTool = {
  name: 'bao_canvas_inspect',
  description: 'READ-ONLY: list the ACTUAL nodes of one BAO free canvas (id, type, position, title, text length and preview, image assetId). Use this to verify prompts or images really exist. canvas_overview only returns canvas metadata (name, revision), NOT nodes — never conclude that nodes are missing from canvas_overview.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['project_id', 'graph_id'],
    properties: {
      project_id: { type: 'string' }, graph_id: { type: 'string' },
      type: { type: 'string', description: 'Optional filter, e.g. "text.input" or "image.input"' },
      preview_chars: { type: 'integer', minimum: 0, maximum: 2000, description: 'Characters of each text to show (default 120)' }
    }
  }
};
const bindingTool = {
  name: 'bao_canvas_repair_media_bindings',
  description: 'Repair image.input nodes whose sourceBinding was lost by an old full canvas save, using EACH NODE’s existing config.assetId. Reads the exact graph, checks expected image count, restores media with canvas.patch attach_media mode=replace in 20-node CAS batches, then verifies. Preserves image identities and positions. No upload, generation, or render.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['project_id', 'graph_id', 'expected_image_count'],
    properties: { project_id: { type: 'string' }, graph_id: { type: 'string' },
      expected_image_count: { type: 'integer', minimum: 1, maximum: 1000 } }
  }
};
const webtoonTool = {
  name: 'bao_webtoon_upload',
  description: 'DIRECT binary upload from a Flash /files/images/... or /files/uploads/... image to the BAO cloud webtoon START-frame workflow. action=source uploads the complete page (up to 50 MiB), frame uploads an exact source tile with 0-based order and original pixel bounds (up to 8 MiB), crop uploads an approved proposal panel crop (up to 8 MiB). PNG/JPEG/WebP. Returns IDs for production_read and webtoon.start_frame_* operations. Uses saved BAO MCP credentials; no manual URL, token or user upload needed. No image/video generation.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['project_id', 'action', 'path'],
    properties: {
      project_id: { type: 'string' }, action: { type: 'string', enum: ['source', 'frame', 'crop'] },
      path: { type: 'string' }, name: { type: 'string' }, episode_code: { type: 'string' },
      page_order: { type: 'integer' }, source_id: { type: 'string' }, source_sha256: { type: 'string' },
      frame_order: { type: 'integer' },
      crop_bounds: { type: 'object', required: ['x', 'y', 'width', 'height'], additionalProperties: false,
        properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } } },
      proposal_revision: { type: 'integer' }, panel_order: { type: 'integer' }
    }
  }
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const editorServicesTool = {
  name: 'bao_editor_services',
  description: 'LOCAL BAO editor worker recovery. action=status reads the fixed local renderer/decoder profiles and verifies saved PID, Node executable, exact runner and project scope. action=start requires exact project_id and starts only a stopped allowlisted worker, hidden and scoped to that project, using saved BAO MCP credentials in memory. Running workers are reused, never killed or restarted. Use for waiting_for_renderer or video frame queues; provider production render_queue is separate. This tool submits no export/frame request, generates no media and requires no web login or shell.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['status', 'start'] },
      services: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['renderer', 'decoder'] }, description: 'Optional; defaults to both services' },
      project_id: { type: 'string', pattern: '^(?:bao|bao-[a-f0-9]{32})$', description: 'Exact BAO project ID; required for start. Optional scope check for status.' }
    },
    allOf: [{ if: { properties: { action: { const: 'start' } } }, then: { required: ['project_id'] } }]
  }
};
function toolArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value || {};
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'arguments')) return value;
  const nested = value.arguments;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
  if (typeof nested === 'string') {
    try {
      const parsed = JSON.parse(nested);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* return the original object for an actionable validation error */ }
  }
  return value;
}
const store = {
  dirs: { images: path.join(data, 'images'), uploads: path.join(data, 'uploads') },
  getMcpConfig: () => JSON.parse(fs.readFileSync(path.join(data, 'mcp.json'), 'utf8'))
};

async function handle(message) {
  if (message.id === undefined) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return ok({ protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'bao-local-files', version: '1.0.0' } });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: [canvasTool, tool, fileTool, patchTool, wireVideoTool, videoInputsTool, textTool, inspectTool, bindingTool, webtoonTool, editorServicesTool] });
    case 'tools/call': {
      if (![canvasTool.name, tool.name, fileTool.name, patchTool.name, wireVideoTool.name, videoInputsTool.name, textTool.name, inspectTool.name, bindingTool.name, webtoonTool.name, editorServicesTool.name].includes(message.params?.name)) return ok({ content: [{ type: 'text', text: 'Unknown tool' }], isError: true });
      try {
        const action = message.params.name === editorServicesTool.name ? baoEditorServices
          : message.params.name === canvasTool.name ? uploadBaoToCanvas
          : message.params.name === inspectTool.name ? inspectBaoCanvas
          : message.params.name === patchTool.name ? patchBaoCanvas
          : message.params.name === wireVideoTool.name ? wireBaoCanvasVideos
          : message.params.name === videoInputsTool.name ? inspectBaoVideoInputs
          : message.params.name === textTool.name ? setBaoCanvasText
          : message.params.name === bindingTool.name ? repairBaoCanvasBindings
          : message.params.name === webtoonTool.name ? uploadBaoWebtoon
          : message.params.name === fileTool.name ? uploadBaoFiles : uploadBaoImages;
        const result = await action(toolArguments(message.params.arguments), { store });
        return ok({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}),
          ...(result.structure ? { structuredContent: { structure: result.structure } } : {}) });
      } catch (error) {
        return ok({ content: [{ type: 'text', text: error instanceof Error ? error.message : 'Upload failed' }], isError: true });
      }
    }
    default:
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try { void handle(JSON.parse(line)); } catch { /* malformed notification */ }
});
