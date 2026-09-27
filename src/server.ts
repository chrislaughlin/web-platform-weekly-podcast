import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { z } from "zod";
import { logger } from "./logger.js";
import { executeRun } from "./pipeline.js";
import { getRun, listRuns } from "./store.js";

const app = Fastify({ logger: true });
const sourceSchema = z.enum(["javascript-weekly", "this-week-in-react", "both"]);
const sourceUrlsSchema = z.object({
  "javascript-weekly": z.array(z.string().url()).optional(),
  "this-week-in-react": z.array(z.string().url()).optional()
}).partial();

app.get("/", async (_, reply) => reply.type("text/html").send(INDEX_HTML));
app.get("/api/runs", async () => listRuns());
app.get("/api/runs/:id", async (request, reply) => {
  const run = await getRun((request.params as { id: string }).id);
  return run ? run : reply.code(404).send({ error: "Run not found" });
});
app.post("/api/runs", async (request, reply) => {
  const body = z.object({ source: sourceSchema, url: z.string().url().optional(), urls: z.array(z.string().url()).min(1).optional(), urlsBySource: sourceUrlsSchema.optional(), issueNumber: z.string().optional(), bypass: z.boolean().default(false) }).parse(request.body);
  const urls = body.urls ?? (body.url ? [body.url] : undefined);
  logger.info("api.run-requested", { source: body.source, urlCount: urls?.length ?? 0, urlsBySource: body.urlsBySource ? Object.fromEntries(Object.entries(body.urlsBySource).map(([source, sourceUrls]) => [source, sourceUrls?.length ?? 0])) : undefined, issueNumber: body.issueNumber, bypass: body.bypass });
  const run = await executeRun({ source: body.source, requestedUrls: urls, requestedUrlsBySource: body.urlsBySource, issueNumber: body.issueNumber, bypass: body.bypass });
  logger.info("api.run-finished", { runId: run.id, status: run.status });
  return reply.code(run.status === "failed" ? 500 : 201).send(run);
});

const artifactRoot = path.resolve(process.env.DATA_DIR ?? "./data", "artifacts");
app.get("/artifacts/:runId/*", async (request, reply) => {
  const params = request.params as { runId: string; "*": string };
  const run = await getRun(params.runId);
  if (!run?.artifactFolder) return reply.callNotFound();
  return reply.redirect(`/artifacts/${run.artifactFolder}/${params["*"]}`);
});
await app.register(fastifyStatic, { root: artifactRoot, prefix: "/artifacts/", decorateReply: false });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
logger.info("server.started", { port: Number(process.env.PORT ?? 3000), artifactRoot, openaiConfigured: Boolean(process.env.OPENAI_API_KEY), elevenLabsConfigured: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) });

const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Web Platform Weekly Podcast</title><style>body{font-family:system-ui;max-width:900px;margin:40px auto;padding:0 20px;background:#10131c;color:#f4f6fb}form,section{background:#191e2b;padding:24px;border-radius:16px;margin:16px 0}input,select,textarea,button{padding:11px;border-radius:8px;border:1px solid #3d465d;margin:6px 0;background:#111622;color:#fff}input,textarea{width:95%}textarea{min-height:110px;resize:vertical}button{cursor:pointer;background:#7457ff;border:0;font-weight:700}.run{border-top:1px solid #3d465d;padding:14px 0}a{color:#a99aff}small{color:#aab2c5}.both-only{display:none}</style></head><body><h1>Web Platform Weekly Podcast</h1><p>Generate one 15-minute-plus episode from JavaScript Weekly, This Week in React, or both feeds. Stories covered by both feeds are merged into one section.</p><form id="form"><label>Source<br><select name="source"><option value="both">Both feeds</option><option value="javascript-weekly">JavaScript Weekly</option><option value="this-week-in-react">This Week in React</option></select></label><br><label class="single-url">Issue URLs (one per line, optional)<br><textarea name="urls" placeholder="Paste one or more newsletter URLs"></textarea></label><label class="both-only">JavaScript Weekly URLs (one per line, optional)<br><textarea name="jsUrls" placeholder="Leave blank to use the latest issue"></textarea></label><label class="both-only">This Week in React URLs (one per line, optional)<br><textarea name="reactUrls" placeholder="Leave blank to use the latest issue"></textarea></label><br><label>JavaScript Weekly issue number (optional)<br><input name="issueNumber" placeholder="803"></label><br><label><input type="checkbox" name="bypass"> Bypass duplicate checks</label><br><button>Generate episode</button></form><section><h2>Runs</h2><div id="runs">Loading…</div></section><script>const form=document.querySelector('#form');const source=document.querySelector('[name=source]');const singleUrl=document.querySelector('.single-url');const bothFields=[...document.querySelectorAll('.both-only')];const runs=document.querySelector('#runs');function updateFields(){const both=source.value==='both';singleUrl.style.display=both?'none':'';bothFields.forEach(field=>field.style.display=both?'':'none')}source.addEventListener('change',updateFields);updateFields();async function refresh(){const data=await fetch('/api/runs').then(r=>r.json());runs.innerHTML=data.map(r=>'<div class="run"><b>'+r.status+'</b> · '+r.source+' · '+(r.issues?.length||1)+' issue(s) · '+new Date(r.createdAt).toLocaleString()+(r.bypass?' · bypass':'')+'<br><small>'+ (r.script?.title||r.error||'') +'</small>'+(r.status==='completed'?'<br><a href="/artifacts/'+r.id+'/audio/audio.mp3">audio</a> · <a href="/artifacts/'+r.id+'/cover-art/cover.png">cover art</a> · <a href="/artifacts/'+r.id+'/script/script.json">script</a> · <a href="/artifacts/'+r.id+'/description.txt">description</a>':'')+'</div>').join('')||'No runs yet.'}form.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(form);const lines=name=>String(f.get(name)||'').split(/\\n/).map(v=>v.trim()).filter(Boolean);const both=f.get('source')==='both';const body={source:f.get('source'),urls:both?undefined:lines('urls'),urlsBySource:both?{'javascript-weekly':lines('jsUrls'),'this-week-in-react':lines('reactUrls')}:undefined,issueNumber:f.get('issueNumber')||undefined,bypass:f.has('bypass')};runs.textContent='Generating…';await fetch('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});await refresh()});refresh();</script></body></html>`;
