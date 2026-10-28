import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// USD per million tokens (checked Oct 2026). Web search billed per search.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-5-5": { in: 0.10, out: 0.50 },
  "claude-sonnet-5-5": { in: 2.0, out: 10.0 },
};
const WEB_SEARCH_USD = 0.01;
const MAX_LOOPS = 12;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = (today: string, s: any) => `You are "Wakeel" (وكيل), the personal AI sales assistant inside a one-person CRM.
The user is Ahmed Salah, a freelance sales acquisition rep selling SchoolOS in Egypt (Alexandria first, then Cairo, later the Gulf).
Today is ${today} (Africa/Cairo).

LANGUAGE: Reply in the language the user writes in. Arabic → Egyptian Arabic, clear and short. English → professional English.
Emails/messages to schools: write in the language that fits the school (Arabic for national/Azhar schools, English or bilingual for international/language schools) unless told otherwise.

PRODUCT — SchoolOS (منصة تشغيل المؤسسات التعليمية): one connected platform where every role lands on its own work:
- Owner compares campuses (students, 30-day attendance, collection rate, families with balances).
- Principal: who needs intervention, today's money, pending approvals, honest daily absence.
- Teacher: today's periods, missed attendance, one-tap "all present", homework and grades in place.
- Parent (phone): weekly absence, new grades (only after publishing), homework, balance & next installment — fewer calls to school.
- Student account: own day, homework submission.
- Accountant / Purchasing / HR desks; finance ledger with gapless invoice numbers, approved discounts, tax; contracts, purchasing, payroll with separation of duties; requests & approvals routed by the school; asset register with QR; operation-level permissions; readable audit log; Arabic / English / French.
- Problems it solves: scattered data, departments that don't see each other, parents calling 3 people for one question, WhatsApp groups with no privacy or record, decisions with no trail.
- Offer: "we build your structure, subjects and team accounts in one session, then you run a real week on your own data".
PRICING: standard 300 EGP per student per year (Ahmed decides deal terms, may discount). Ahmed earns ${s?.commission_pct ?? 20}% commission.
Deal value = students × price × (1 − discount%). Stage probabilities: discovery 10, demo 30, proposal 50, negotiation 75, won 100, lost 0.

TARGETS: only educational institutions — schools (private, language, international, national, Azhar), universities, institutes, nurseries.
QUALIFICATION (score 0-100): size (students; 300+ strong), fees level/ability to pay, multi-campus, current system pain (paper/Excel/WhatsApp = good), access to decision maker (owner/board), timing (start of term, budget season). Explain the score briefly in score_notes.

RULES:
- Use tools to read/write the CRM. Never invent data; if something is missing, ask or leave it empty.
- Before creating an institution, search to avoid duplicates.
- You HAVE a web_search tool. Never tell Ahmed you cannot search the web.
- ACT, don't ask: when a request has a sensible default, do it right away and say which default you used. Ask at most one short question, only when nothing reasonable can be assumed.
- Lead generation: run several web searches (vary area + type, e.g. "مدارس لغات سموحة", "international schools Alexandria", "حضانات ستانلي", Google Maps/Facebook/school directories). Alexandria areas to cover: Smouha, Stanley, Rushdy, Gleem, Sporting, Louran, Miami, Sidi Bishr, Mandara, Agami, Sidi Gaber, Kafr Abdo, Moharram Bek, Borg El Arab.
  Collect real institutions with whatever you found (name, type, category, area, city, phone, website, students if stated). Only save what you actually found, never invent phones or numbers; put the source URL in "source". Import them with import_institutions, including score and a short score_notes for each in the same call (one call for the whole batch).
  If you found fewer than asked, say how many and offer to continue with other areas.
- Outreach: you can NOT send emails or WhatsApp yourself. Save drafts with save_message_draft; Ahmed reviews and sends with one tap. Keep cold messages short (≤120 words), one clear ask (15-minute call or a demo), personalised to the school.
- Appointments: when a meeting is agreed, log it with create_task type "meeting" and the date/time in Cairo time.
- Keep replies brief: confirm what you did in a few lines, then suggest the next best action.
${s?.signature ? "Ahmed's signature:\n" + s.signature : ""}`;

const tools = [
  { name: "search_institutions", description: "Search institutions by name/city/status. Returns up to 25.",
    input_schema: { type: "object", properties: { query: { type: "string" }, city: { type: "string" }, status: { type: "string" } } } },
  { name: "get_institution", description: "Full record of one institution: contacts, opportunities, recent activities.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "create_institution", description: "Create one institution (lead).",
    input_schema: { type: "object", properties: {
      name: { type: "string" }, name_en: { type: "string" },
      type: { type: "string", enum: ["school", "university", "institute", "nursery", "other"] },
      category: { type: "string", description: "e.g. international, language, national, azhar, private" },
      city: { type: "string" }, area: { type: "string" }, address: { type: "string" }, phone: { type: "string" },
      email: { type: "string" }, website: { type: "string" }, students_count: { type: "integer" },
      fees_level: { type: "string", enum: ["low", "mid", "high"] }, current_system: { type: "string" },
      source: { type: "string" }, notes: { type: "string" } }, required: ["name"] } },
  { name: "import_institutions", description: "Bulk-create institutions found by research (up to 50). Each item takes the same fields as create_institution plus score (0-100) and score_notes, so score them in the same call. Skips duplicates (same name and city).",
    input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object" } } }, required: ["items"] } },
  { name: "update_institution", description: "Update fields of an institution: status (new/contacted/qualified/unqualified/customer/lost), score, score_notes, next_step, next_step_date, students_count, etc.",
    input_schema: { type: "object", properties: { id: { type: "string" }, fields: { type: "object" } }, required: ["id", "fields"] } },
  { name: "add_contact", description: "Add a person at an institution.",
    input_schema: { type: "object", properties: {
      institution_id: { type: "string" }, full_name: { type: "string" }, role: { type: "string" },
      decision_role: { type: "string", enum: ["decision_maker", "influencer", "user", "gatekeeper"] },
      phone: { type: "string" }, whatsapp: { type: "string" }, email: { type: "string" }, notes: { type: "string" } },
      required: ["institution_id", "full_name"] } },
  { name: "log_activity", description: "Log something that already happened (call, whatsapp, email, meeting, visit, note).",
    input_schema: { type: "object", properties: {
      institution_id: { type: "string" }, contact_id: { type: "string" }, opportunity_id: { type: "string" },
      type: { type: "string", enum: ["call", "whatsapp", "email", "meeting", "visit", "note"] },
      subject: { type: "string" }, body: { type: "string" }, outcome: { type: "string" } },
      required: ["type", "subject"] } },
  { name: "create_task", description: "Schedule a future action/appointment. due_at is ISO datetime in Cairo time, e.g. 2026-11-02T11:00:00+03:00.",
    input_schema: { type: "object", properties: {
      institution_id: { type: "string" }, contact_id: { type: "string" }, opportunity_id: { type: "string" },
      type: { type: "string", enum: ["call", "whatsapp", "email", "meeting", "visit", "task"] },
      subject: { type: "string" }, body: { type: "string" }, due_at: { type: "string" } },
      required: ["type", "subject", "due_at"] } },
  { name: "complete_task", description: "Mark a planned task done, with outcome.",
    input_schema: { type: "object", properties: { id: { type: "string" }, outcome: { type: "string" } }, required: ["id"] } },
  { name: "list_tasks", description: "List planned tasks. scope: overdue, today, week, all.",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["overdue", "today", "week", "all"] } } } },
  { name: "create_opportunity", description: "Create a deal. price_per_student defaults to 300 EGP.",
    input_schema: { type: "object", properties: {
      institution_id: { type: "string" }, name: { type: "string" }, students: { type: "integer" },
      price_per_student: { type: "number" }, discount_pct: { type: "number" },
      stage: { type: "string", enum: ["discovery", "demo", "proposal", "negotiation", "won", "lost"] },
      expected_close: { type: "string", description: "YYYY-MM-DD" }, notes: { type: "string" } },
      required: ["institution_id", "name", "students"] } },
  { name: "update_opportunity", description: "Update a deal (stage, students, price_per_student, discount_pct, probability, expected_close, lost_reason, notes).",
    input_schema: { type: "object", properties: { id: { type: "string" }, fields: { type: "object" } }, required: ["id", "fields"] } },
  { name: "pipeline_forecast", description: "Pipeline totals and quarterly forecast (deal value, weighted value, commission).",
    input_schema: { type: "object", properties: {} } },
  { name: "list_cadences", description: "List outreach cadences.", input_schema: { type: "object", properties: {} } },
  { name: "enroll_in_cadence", description: "Start a cadence for an institution (creates its planned steps).",
    input_schema: { type: "object", properties: { cadence_id: { type: "string" }, institution_id: { type: "string" }, contact_id: { type: "string" } },
      required: ["cadence_id", "institution_id"] } },
  { name: "save_message_draft", description: "Save an email or WhatsApp draft for Ahmed to review and send.",
    input_schema: { type: "object", properties: {
      institution_id: { type: "string" }, contact_id: { type: "string" },
      channel: { type: "string", enum: ["email", "whatsapp"] }, subject: { type: "string" }, body: { type: "string" } },
      required: ["channel", "body"] } },
];

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const qOf = (d: string | null) => {
  if (!d) return "بدون تاريخ";
  const dt = new Date(d); return `${dt.getFullYear()}-Q${Math.floor(dt.getMonth() / 3) + 1}`;
};

async function runTool(sb: any, name: string, a: any): Promise<unknown> {
  const r = (x: any) => { if (x.error) throw new Error(x.error.message); return x.data; };
  switch (name) {
    case "search_institutions": {
      let q = sb.from("institutions").select("id,name,name_en,type,category,city,area,status,score,students_count,phone,next_step,next_step_date").order("updated_at", { ascending: false }).limit(25);
      if (a.query) q = q.or(`name.ilike.%${a.query}%,name_en.ilike.%${a.query}%`);
      if (a.city) q = q.ilike("city", `%${a.city}%`);
      if (a.status) q = q.eq("status", a.status);
      return r(await q);
    }
    case "get_institution": {
      const inst = r(await sb.from("institutions").select("*").eq("id", a.id).single());
      const contacts = r(await sb.from("contacts").select("*").eq("institution_id", a.id));
      const opps = r(await sb.from("opportunities").select("*").eq("institution_id", a.id));
      const acts = r(await sb.from("activities").select("id,type,status,subject,body,outcome,due_at,done_at,created_at").eq("institution_id", a.id).order("created_at", { ascending: false }).limit(20));
      return { institution: inst, contacts, opportunities: opps, activities: acts };
    }
    case "create_institution":
      return r(await sb.from("institutions").insert(clean(a)).select("id,name").single());
    case "import_institutions": {
      const out = { created: [] as string[], skipped: [] as string[] };
      for (const it of (a.items || []).slice(0, 50)) {
        if (!it?.name) continue;
        let q = sb.from("institutions").select("id").ilike("name", it.name);
        if (it.city) q = q.ilike("city", it.city);
        const ex = r(await q.limit(1));
        if (ex.length) { out.skipped.push(it.name); continue; }
        const allowed = ["name","name_en","type","category","city","area","address","phone","email","website","students_count","fees_level","current_system","source","notes","score","score_notes"];
        const row = clean(Object.fromEntries(Object.entries(it).filter(([k]) => allowed.includes(k))));
        r(await sb.from("institutions").insert(row));
        out.created.push(it.name);
      }
      return out;
    }
    case "update_institution": {
      const f = { ...a.fields }; delete f.id; delete f.owner_id;
      return r(await sb.from("institutions").update(f).eq("id", a.id).select("id,name,status,score").single());
    }
    case "add_contact":
      return r(await sb.from("contacts").insert(clean(a)).select("id,full_name").single());
    case "log_activity": {
      const row = r(await sb.from("activities").insert(clean({ ...a, status: "done", done_at: new Date().toISOString() })).select("id").single());
      if (a.institution_id) await sb.from("institutions").update({ status: "contacted" }).eq("id", a.institution_id).eq("status", "new");
      return row;
    }
    case "create_task":
      return r(await sb.from("activities").insert(clean({ ...a, status: "planned" })).select("id,subject,due_at").single());
    case "complete_task":
      return r(await sb.from("activities").update(clean({ status: "done", done_at: new Date().toISOString(), outcome: a.outcome })).eq("id", a.id).select("id").single());
    case "list_tasks": {
      const now = new Date();
      let q = sb.from("activities").select("id,type,subject,body,due_at,institution_id,institutions(name)").eq("status", "planned").order("due_at").limit(50);
      const end = new Date(now);
      if (a.scope === "overdue") q = q.lt("due_at", now.toISOString());
      else if (a.scope === "today") { end.setHours(23, 59, 59); q = q.lte("due_at", end.toISOString()); }
      else if (a.scope === "week") { end.setDate(end.getDate() + 7); q = q.lte("due_at", end.toISOString()); }
      return r(await q);
    }
    case "create_opportunity": {
      const row = r(await sb.from("opportunities").insert(clean(a)).select("id,name,amount,commission,stage,probability").single());
      await sb.from("institutions").update({ status: "qualified" }).eq("id", a.institution_id).in("status", ["new", "contacted"]);
      return row;
    }
    case "update_opportunity": {
      const f = { ...a.fields }; delete f.id; delete f.owner_id; delete f.amount; delete f.commission;
      return r(await sb.from("opportunities").update(f).eq("id", a.id).select("id,name,stage,amount,commission,probability").single());
    }
    case "pipeline_forecast": {
      const opps = r(await sb.from("opportunities").select("stage,amount,commission,probability,expected_close,closed_at"));
      const byQ: Record<string, any> = {};
      const tot = { open_value: 0, weighted_value: 0, weighted_commission: 0, won_value: 0, won_commission: 0 };
      for (const o of opps) {
        if (o.stage === "lost") continue;
        const key = o.stage === "won" ? qOf(o.closed_at) : qOf(o.expected_close);
        byQ[key] ??= { deals: 0, value: 0, weighted: 0, commission_weighted: 0, won: 0, won_commission: 0 };
        const b = byQ[key]; b.deals++;
        if (o.stage === "won") { b.won += +o.amount; b.won_commission += +o.commission; tot.won_value += +o.amount; tot.won_commission += +o.commission; }
        else { b.value += +o.amount; b.weighted += o.amount * o.probability / 100; b.commission_weighted += o.commission * o.probability / 100;
          tot.open_value += +o.amount; tot.weighted_value += o.amount * o.probability / 100; tot.weighted_commission += o.commission * o.probability / 100; }
      }
      return { currency: "EGP", totals: tot, by_quarter: byQ };
    }
    case "list_cadences":
      return r(await sb.from("cadences").select("id,name,steps"));
    case "enroll_in_cadence":
      return r(await sb.rpc("enroll_in_cadence", { p_cadence: a.cadence_id, p_institution: a.institution_id, p_contact: a.contact_id ?? null }));
    case "save_message_draft":
      return r(await sb.from("activities").insert(clean({
        institution_id: a.institution_id, contact_id: a.contact_id, type: a.channel, status: "draft", subject: a.subject, body: a.body,
      })).select("id").single());
    default:
      throw new Error("Unknown tool " + name);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: "unauthorized" }, 401);
    const uid = u.user.id;

    let key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) {
      const { data: k } = await admin.from("api_keys").select("anthropic_key").eq("owner_id", uid).maybeSingle();
      key = k?.anthropic_key;
    }
    if (!key) return json({ error: "missing_api_key", message: "Add your Anthropic API key in Settings." }, 400);

    const { message, reset } = await req.json();
    if (reset) { await sb.from("agent_messages").delete().eq("owner_id", uid); return json({ ok: true }); }
    if (!message || typeof message !== "string") return json({ error: "empty" }, 400);

    const { data: s } = await sb.from("settings").select("*").eq("owner_id", uid).maybeSingle();
    const model = s?.agent_model || "claude-haiku-5-5";
    const price = PRICES[model] ?? PRICES["claude-haiku-5-5"];

    // monthly budget guard
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const { data: usage } = await sb.from("agent_usage").select("cost_usd").gte("created_at", monthStart.toISOString());
    const spent = (usage ?? []).reduce((t: number, x: any) => t + Number(x.cost_usd), 0);
    const budget = Number(s?.agent_monthly_budget_usd ?? 10);
    if (spent >= budget) return json({ error: "budget", message: `Monthly agent budget reached ($${spent.toFixed(2)} / $${budget}).` }, 402);

    const { data: hist } = await sb.from("agent_messages").select("role,content").order("created_at", { ascending: false }).limit(16);
    const history = (hist ?? []).reverse().map((m: any) => ({ role: m.role, content: m.content }));
    while (history.length && history[0].role !== "user") history.shift();
    const messages: any[] = [...history, { role: "user", content: message }];

    const today = new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "full", timeStyle: "short" });
    let inTok = 0, outTok = 0, searches = 0, finalText = "";
    const actions: string[] = [];
    let useSearch = true; let searchError = "";

    for (let i = 0; i < MAX_LOOPS; i++) {
      const body: any = {
        model, max_tokens: 8000, system: SYSTEM(today, s) + (useSearch ? "" : `\nNOTE: the web_search tool failed this turn (${searchError}). Tell Ahmed in one line that web search failed and quote this reason.`), messages,
        tools: [...tools, ...(useSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_callers: ["direct"] }] : [])],
      };
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (useSearch && JSON.stringify(data).includes("web_search")) { useSearch = false; searchError = data?.error?.message || "web search unavailable"; i--; continue; }
        throw new Error(data?.error?.message || "Claude API error");
      }
      inTok += (data.usage?.input_tokens ?? 0) + (data.usage?.cache_read_input_tokens ?? 0) + (data.usage?.cache_creation_input_tokens ?? 0);
      outTok += data.usage?.output_tokens ?? 0;
      searches += data.usage?.server_tool_use?.web_search_requests ?? 0;
      messages.push({ role: "assistant", content: data.content });

      const texts = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (texts) finalText = texts;

      if (data.stop_reason === "pause_turn") continue;
      if (data.stop_reason !== "tool_use") break;

      const results = [];
      for (const b of data.content) {
        if (b.type !== "tool_use") continue;
        try {
          const out = await runTool(sb, b.name, b.input);
          actions.push(b.name);
          results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 12000) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, content: "Error: " + (e as Error).message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }

    const cost = inTok / 1e6 * price.in + outTok / 1e6 * price.out + searches * WEB_SEARCH_USD;
    await admin.from("agent_usage").insert({ owner_id: uid, model, input_tokens: inTok, output_tokens: outTok, web_searches: searches, cost_usd: cost });
    await sb.from("agent_messages").insert([{ role: "user", content: message }, { role: "assistant", content: finalText || "✓" }]);

    return json({ reply: finalText, actions, search_error: searchError || undefined, usage: { input_tokens: inTok, output_tokens: outTok, web_searches: searches, cost_usd: cost, month_spent_usd: spent + cost, budget_usd: budget } });
  } catch (e) {
    return json({ error: "server", message: (e as Error).message }, 500);
  }
});
