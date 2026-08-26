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
	composePromptWithAttachments,
	resolveAttachmentPath,
	sanitizeFilename,
	saveAttachment,
	UnknownAttachmentError,
} from "../src/runtime/attachments.js";
import { ProjectRegistry } from "../src/runtime/projectRegistry.js";

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

	test("composePromptWithAttachments appends the note only when paths exist", () => {
		assert.equal(composePromptWithAttachments("hi", []), "hi");
		const composed = composePromptWithAttachments("summarize this", ["attachments/x/report.pdf"]);
		assert.match(composed, /^summarize this\n\n\[The user attached/);
		assert.match(composed, /- attachments\/x\/report\.pdf/);
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
