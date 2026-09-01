/**
 * Attachment storage + routes.
 *
 * Unit level: the storage module (sanitize, save, resolve, prompt composition).
 * HTTP level: upload route stores the decoded bytes inside the project
 * workspace and returns the contract metadata; the prompt route rejects
 * unknown attachment ids with a 400. No LLM call is ever made.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createAttachmentsApp } from "../src/http/attachmentsRoutes.js";
import { createSessionsApp } from "../src/http/sessionsRoutes.js";
import {
	ATTACHMENT_NOTE_CLOSE,
	ATTACHMENT_NOTE_OPEN,
	type AttachmentInfo,
	AttachmentQuotaError,
	composePromptWithAttachments,
	MAX_PROJECT_ATTACHMENT_BYTES,
	resolveAttachmentPath,
	sanitizeFilename,
	saveAttachment,
	UnknownAttachmentError,
} from "../src/runtime/attachments.js";
import { ProjectRegistry } from "../src/runtime/projectRegistry.js";
import type { ProjectRuntime } from "../src/runtime/projectRuntime.js";

async function pickPort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv: Server = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as AddressInfo).port;
			srv.close((err) => (err ? rej(err) : res(port)));
		});
	});
}

describe("attachments: storage module", () => {
	const dir = mkdtempSync(resolve(tmpdir(), "agent-server-attach-unit-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	test("sanitizeFilename strips directories, separators, and control chars", () => {
		assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
		assert.equal(sanitizeFilename("..\\windows\\evil.txt"), "evil.txt");
		assert.equal(sanitizeFilename("re\u0000port:v1.pdf"), "reportv1.pdf");
		assert.equal(sanitizeFilename("..."), "file");
		assert.equal(sanitizeFilename("plain.txt"), "plain.txt");
	});

	test("saveAttachment writes bytes under attachments/<id>/<filename> and resolves back", () => {
		const info = saveAttachment(dir, "notes.txt", Buffer.from("hello attachments"));
		assert.match(info.id, /^[0-9a-f-]{36}$/);
		assert.equal(info.filename, "notes.txt");
		assert.equal(info.path, `attachments/${info.id}/notes.txt`);
		assert.equal(info.size, "hello attachments".length);
		assert.equal(readFileSync(resolve(dir, info.path), "utf8"), "hello attachments");
		assert.equal(resolveAttachmentPath(dir, info.id), info.path);
	});

	test("resolveAttachmentPath rejects unknown and malformed ids", () => {
		assert.throws(() => resolveAttachmentPath(dir, "11111111-1111-4111-8111-111111111111"), UnknownAttachmentError);
		assert.throws(() => resolveAttachmentPath(dir, "../escape"), UnknownAttachmentError);
	});

	test("sanitizeFilename bounds the name by UTF-8 bytes, keeping the extension", () => {
		// 255 UTF-16 code units of CJK is 765 bytes — over the POSIX 255-byte cap
		// on a path segment, which would make writeFileSync throw ENAMETOOLONG.
		const long = `${"文".repeat(250)}.txt`;
		const safe = sanitizeFilename(long);
		assert.ok(Buffer.byteLength(safe) <= 200, `expected <=200 bytes, got ${Buffer.byteLength(safe)}`);
		assert.ok(safe.endsWith(".txt"));
		// Truncation must not split a multi-byte code point.
		assert.ok(!safe.includes("�"));
		assert.equal(sanitizeFilename(`${"a".repeat(300)}`).length, 200);
	});

	test("saveAttachment stores a long multibyte filename without throwing", () => {
		const info = saveAttachment(dir, `${"漢字".repeat(120)}.md`, Buffer.from("ok"));
		assert.equal(readFileSync(resolve(dir, info.path), "utf8"), "ok");
		assert.equal(resolveAttachmentPath(dir, info.id), info.path);
	});

	test("saveAttachment stores a zero-byte file", () => {
		const info = saveAttachment(dir, "empty.log", Buffer.alloc(0));
		assert.equal(info.size, 0);
		assert.equal(readFileSync(resolve(dir, info.path), "utf8"), "");
	});

	test("saveAttachment refuses to exceed the per-project quota", () => {
		const quotaDir = mkdtempSync(resolve(tmpdir(), "agent-server-attach-quota-"));
		try {
			assert.throws(
				() => saveAttachment(quotaDir, "huge.bin", Buffer.alloc(MAX_PROJECT_ATTACHMENT_BYTES + 1)),
				AttachmentQuotaError,
			);
			// Nothing was written, so a normal upload still succeeds afterwards.
			assert.equal(saveAttachment(quotaDir, "small.bin", Buffer.from("ok")).size, 2);
		} finally {
			rmSync(quotaDir, { recursive: true, force: true });
		}
	});

	test("composePromptWithAttachments wraps the note in the delimiters agent-client strips", () => {
		assert.equal(composePromptWithAttachments("hi", []), "hi");
		const composed = composePromptWithAttachments("summarize this", ["attachments/x/report.pdf"]);
		// agent-client's stripAttachmentNote() matches exactly this shape; keep the
		// two in sync (packages/agent-client/src/core/attachments.ts).
		assert.equal(ATTACHMENT_NOTE_OPEN, "<attached-files>");
		assert.equal(ATTACHMENT_NOTE_CLOSE, "</attached-files>");
		assert.match(composed, /^summarize this\n\n<attached-files>\n/);
		assert.match(composed, /\n- attachments\/x\/report\.pdf\n<\/attached-files>$/);
	});
});

describe("attachments: HTTP surface", () => {
	let baseUrl: string;
	let workspaceDir: string;
	let projectDir: string;
	let close: () => Promise<void>;

	before(async () => {
		workspaceDir = mkdtempSync(resolve(tmpdir(), "agent-server-attach-http-"));
		const registry = await ProjectRegistry.create({
			workspaceDir,
			logger: { log: () => {}, error: () => {} },
		});
		const project = registry.createProject({ name: "attach" });
		projectDir = project.projectDir;
		mkdirSync(resolve(projectDir, ".pi"), { recursive: true });
		writeFileSync(resolve(projectDir, ".pi/AGENTS.md"), "# test agents file\n");

		const root = new OpenAPIHono();
		const resolver = async (c: { req: { param: (k: string) => string | undefined } }) => {
			const runtime = await registry.getRuntime(c.req.param("projectId") ?? "");
			if (!runtime) throw new Error("project not registered");
			return runtime;
		};
		root.route("/v1/projects/:projectId", createSessionsApp(resolver));
		root.route("/v1/projects/:projectId", createAttachmentsApp(resolver));

		const port = await pickPort();
		const server = serve({ fetch: root.fetch, hostname: "127.0.0.1", port });
		baseUrl = `http://127.0.0.1:${port}/v1/projects/${project.id}`;
		close = () =>
			new Promise<void>((res, rej) => {
				server.close((err) => (err ? rej(err) : res()));
			});
	});

	after(async () => {
		await close();
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	test("POST /attachments stores the decoded file in the project workspace", async () => {
		const res = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				filename: "secret.txt",
				contentBase64: Buffer.from("the passphrase is mangosteen").toString("base64"),
			}),
		});
		assert.equal(res.status, 200);
		const info = (await res.json()) as { id: string; path: string; filename: string; size: number };
		assert.equal(info.filename, "secret.txt");
		assert.equal(info.path, `attachments/${info.id}/secret.txt`);
		assert.equal(readFileSync(resolve(projectDir, info.path), "utf8"), "the passphrase is mangosteen");
	});

	test("POST /attachments rejects non-base64 content", async () => {
		const res = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ filename: "x.bin", contentBase64: "!!!not-base64!!!" }),
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /base64/);
	});

	test("POST /attachments rejects truncated base64 instead of storing a corrupt file", async () => {
		// "AAAAA" is 5 chars: a whole group plus a stray char that Buffer silently
		// discards, so the stored size would not match what the caller uploaded.
		const res = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ filename: "x.bin", contentBase64: "AAAAA" }),
		});
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /base64/);
	});

	test("POST /attachments stores a zero-byte file", async () => {
		const res = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ filename: "empty.txt", contentBase64: "" }),
		});
		assert.equal(res.status, 200);
		const info = (await res.json()) as { path: string; size: number };
		assert.equal(info.size, 0);
		assert.equal(readFileSync(resolve(projectDir, info.path), "utf8"), "");
	});

	test("POST /attachments reports a validation failure as ErrorResponse, not a zod tree", async () => {
		const res = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ filename: "", contentBase64: "AAAA" }),
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error?: string };
		assert.equal(typeof body.error, "string");
		assert.match(body.error ?? "", /filename/);
	});

	test("POST /sessions/{id}/prompt rejects unknown attachment ids with 400", async () => {
		const created = await fetch(`${baseUrl}/sessions`, { method: "POST" });
		assert.equal(created.status, 200);
		const { id } = (await created.json()) as { id: string };

		const res = await fetch(`${baseUrl}/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "read it", attachments: ["11111111-1111-4111-8111-111111111111"] }),
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /unknown attachment id/);
	});
});

describe("attachments: request limits", () => {
	/**
	 * The routes mounted as the server mounts them, over a ProjectRuntime stub
	 * (the upload route only ever calls saveAttachment) and a tiny body limit.
	 */
	const appWith = (saveAttachment: (filename: string, data: Buffer) => AttachmentInfo) => {
		const root = new OpenAPIHono();
		root.route(
			"/v1/projects/:projectId",
			createAttachmentsApp(() => ({ saveAttachment }) as unknown as ProjectRuntime, { maxBodyBytes: 64 }),
		);
		return root;
	};
	const url = "/v1/projects/p1/attachments";

	test("an oversized body is rejected with 413 before the payload is parsed", async () => {
		let saved = false;
		const app = appWith(() => {
			saved = true;
			throw new Error("unreachable");
		});
		const res = await app.request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			// Well past the 64-byte limit configured above.
			body: JSON.stringify({ filename: "big.bin", contentBase64: "A".repeat(200) }),
		});
		assert.equal(res.status, 413);
		assert.match(((await res.json()) as { error: string }).error, /exceeds 64 bytes/);
		assert.equal(saved, false, "the handler must not run for an over-limit body");
	});

	test("an exhausted project quota is reported as 413, not 500", async () => {
		const app = appWith(() => {
			throw new AttachmentQuotaError(MAX_PROJECT_ATTACHMENT_BYTES, 1);
		});
		const res = await app.request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ filename: "x.bin", contentBase64: "AAAA" }),
		});
		assert.equal(res.status, 413);
		assert.match(((await res.json()) as { error: string }).error, /quota exceeded/);
	});
});
