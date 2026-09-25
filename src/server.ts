import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { z } from "zod";
import { executeRun } from "./pipeline.js";
import { getRun, listRuns } from "./store.js";

const app = Fastify({ logger: true });
const sourceSchema = z.enum(["javascript-weekly", "this-week-in-react"]);

app.get("/", async (_, reply) => reply.type("text/html").send(INDEX_HTML));
app.get("/api/runs", async () => listRuns());
app.get("/api/runs/:id", async (request, reply) => {
  const run = await getRun((request.params as { id: string }).id);
  return run ? run : reply.code(404).send({ error: "Run not found" });
});
app.post("/api/runs", async (request, reply) => {
  const body = z.object({ source: sourceSchema, url: z.string().url().optional(), issueNumber: z.string().optional(), bypass: z.boolean().default(false) }).parse(request.body);
  const run = await executeRun({ source: body.source, requestedUrl: body.url, issueNumber: body.issueNumber, bypass: body.bypass });
  return reply.code(run.status === "failed" ? 500 : 201).send(run);
});

const artifactRoot = path.resolve(process.env.DATA_DIR ?? "./data", "artifacts");
await app.register(fastifyStatic, { root: artifactRoot, prefix: "/artifacts/", decorateReply: false });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Web Platform Weekly Podcast</title><style>body{font-family:system-ui;max-width:900px;margin:40px auto;padding:0 20px;background:#10131c;color:#f4f6fb}form,section{background:#191e2b;padding:24px;border-radius:16px;margin:16px 0}input,select,button{padding:11px;border-radius:8px;border:1px solid #3d465d;margin:6px 0;background:#111622;color:#fff}input{width:95%}button{cursor:pointer;background:#7457ff;border:0;font-weight:700}.run{border-top:1px solid #3d465d;padding:14px 0}a{color:#a99aff}small{color:#aab2c5}</style></head><body><h1>Web Platform Weekly Podcast</h1><p>Generate a reviewable audio episode and cover art from a JavaScript or React newsletter.</p><form id="form"><label>Source<br><select name="source"><option value="javascript-weekly">JavaScript Weekly</option><option value="this-week-in-react">This Week in React</option></select></label><br><label>Issue URL (optional)<br><input name="url" placeholder="Paste a specific newsletter URL"></label><br><label>Issue number (optional)<br><input name="issueNumber" placeholder="803"></label><br><label><input type="checkbox" name="bypass"> Bypass duplicate checks</label><br><button>Generate episode</button></form><section><h2>Runs</h2><div id="runs">Loading…</div></section><script>const form=document.querySelector('#form');const runs=document.querySelector('#runs');async function refresh(){const data=await fetch('/api/runs').then(r=>r.json());runs.innerHTML=data.map(r=>'<div class="run"><b>'+r.status+'</b> · '+r.source+' · '+new Date(r.createdAt).toLocaleString()+(r.bypass?' · bypass':'')+'<br><small>'+ (r.issue?.title||r.error||'') +'</small>'+(r.status==='completed'?'<br><a href="/artifacts/'+r.id+'.mp3">audio</a> · <a href="/artifacts/'+r.id+'.png">cover art</a>':'')+'</div>').join('')||'No runs yet.'}form.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(form);const body={source:f.get('source'),url:f.get('url')||undefined,issueNumber:f.get('issueNumber')||undefined,bypass:f.has('bypass')};runs.textContent='Generating…';await fetch('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});await refresh()});refresh();</script></body></html>`;
