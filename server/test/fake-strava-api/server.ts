import Fastify, { type FastifyReply } from "fastify";
import { FAKE_ATHLETE_ID, type FakeWorld, type WorldActivity, type WorldUpload } from "./world.ts";

/**
 * A fake of the Strava v3 API endpoints cameld uses, over a FakeWorld.
 * SYNTHETIC data only. Photos are served from /cdn/<unique id>, standing in
 * for Strava's image CDN.
 */

export interface FakeStravaApi {
  /** Base for StravaClient (`.../api/v3`). */
  apiBase: string;
  origin: string;
  close(): Promise<void>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function detail(a: WorldActivity, origin: string) {
  return {
    id: a.id,
    athlete: { id: FAKE_ATHLETE_ID },
    name: a.name,
    description: a.description,
    sport_type: a.sportType,
    type: a.sportType,
    start_date: iso(a.startMs),
    start_date_local: iso(a.startMs),
    distance: a.distance,
    moving_time: a.elapsedSeconds,
    elapsed_time: a.elapsedSeconds,
    device_name: a.deviceName ?? undefined,
    external_id: a.externalId,
    gear_id: a.gearId,
    commute: a.commute,
    trainer: a.trainer,
    hide_from_home: a.hideFromHome,
    private_note: a.privateNote,
    total_photo_count: a.photos.length,
    photo_count: 0,
    kudos_count: a.kudos.length,
    comment_count: a.comments.length,
    has_heartrate: a.samples.some((s) => s.heartRate !== undefined),
    map: { summary_polyline: "" },
    photo_base: origin,
  };
}

function uploadJson(u: WorldUpload) {
  const processing = u.pollsLeft > 0;
  return {
    id: u.id,
    id_str: String(u.id),
    external_id: u.externalId,
    error: processing ? null : u.error,
    status: processing
      ? "Your activity is still being processed."
      : u.status === "ready"
        ? "Your activity is ready."
        : "There was an error processing your activity.",
    activity_id: processing ? null : u.activityId,
  };
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    message: "Record Not Found",
    errors: [{ resource: "Activity", field: "id", code: "invalid" }],
  });
}

export async function startFakeStravaApi(world: FakeWorld): Promise<FakeStravaApi> {
  const app = Fastify({ logger: false });
  let origin = "";
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] as string;
    world.requests.push({ method: request.method, path });
    world.onRequest?.(request.method, path);
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-ratelimit-limit", "200,2000");
    reply.header("x-ratelimit-usage", `1,${world.requests.length}`);
    reply.header("x-readratelimit-limit", "100,1000");
    reply.header("x-readratelimit-usage", `1,${world.requests.length}`);
  });

  app.get("/api/v3/athlete", () => ({ id: FAKE_ATHLETE_ID, firstname: "Synthetic" }));

  app.get<{ Querystring: Record<string, string> }>("/api/v3/athlete/activities", (request) => {
    const q = request.query;
    const after = q.after === undefined ? -Infinity : Number(q.after) * 1000;
    const before = q.before === undefined ? Infinity : Number(q.before) * 1000;
    const perPage = Number(q.per_page ?? 30);
    const page = Number(q.page ?? 1);
    return world
      .live()
      .filter((a) => a.startMs > after && a.startMs < before)
      .sort((a, b) => b.startMs - a.startMs || b.id - a.id)
      .slice((page - 1) * perPage, page * perPage)
      .map((a) => detail(a, origin));
  });

  app.get<{ Params: { id: string } }>("/api/v3/activities/:id", (request, reply) => {
    const a = world.get(Number(request.params.id));
    return a === undefined ? notFound(reply) : detail(a, origin);
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/v3/activities/:id",
    (request, reply) => {
      const a = world.get(Number(request.params.id));
      if (a === undefined) return notFound(reply);
      const b = request.body;
      if (typeof b.name === "string") a.name = b.name;
      if (typeof b.description === "string") a.description = b.description;
      if (typeof b.sport_type === "string") a.sportType = b.sport_type;
      if (typeof b.gear_id === "string") a.gearId = b.gear_id;
      if (typeof b.commute === "boolean") a.commute = b.commute;
      if (typeof b.trainer === "boolean") a.trainer = b.trainer;
      if (typeof b.hide_from_home === "boolean") a.hideFromHome = b.hide_from_home;
      return detail(a, origin);
    },
  );

  app.get<{ Params: { id: string } }>("/api/v3/activities/:id/streams", (request, reply) => {
    const a = world.get(Number(request.params.id));
    if (a === undefined) return notFound(reply);
    if (a.samples.length === 0) return notFound(reply);
    const t0 = a.samples[0]?.time ?? 0;
    const streams: Record<string, unknown> = {
      time: { data: a.samples.map((s) => Math.round((s.time - t0) / 1000)) },
      latlng: {
        data: a.samples.filter((s) => s.lat !== undefined).map((s) => [s.lat, s.lng]),
      },
    };
    const hr = a.samples.filter((s) => s.heartRate !== undefined).map((s) => s.heartRate);
    if (hr.length > 0) streams.heartrate = { data: hr };
    return streams;
  });

  app.get<{ Params: { id: string } }>("/api/v3/activities/:id/photos", (request, reply) => {
    const a = world.get(Number(request.params.id));
    if (a === undefined) return notFound(reply);
    return a.photos.map((p) => ({
      unique_id: p.uniqueId,
      urls: { "100": `${origin}/cdn/small/${p.uniqueId}`, "5000": `${origin}/cdn/${p.uniqueId}` },
      created_at: p.createdAt,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/v3/activities/:id/kudos", (request, reply) => {
    const a = world.get(Number(request.params.id));
    return a === undefined ? notFound(reply) : a.kudos;
  });

  app.get<{ Params: { id: string } }>("/api/v3/activities/:id/comments", (request, reply) => {
    const a = world.get(Number(request.params.id));
    return a === undefined ? notFound(reply) : a.comments;
  });

  app.post("/api/v3/uploads", async (request, reply) => {
    const contentType = request.headers["content-type"] as string;
    const form = await new Response(request.body as Buffer, {
      headers: { "content-type": contentType },
    }).formData();
    const file = form.get("file") as File;
    const upload = world.createUpload({
      bytes: Buffer.from(await file.arrayBuffer()),
      dataType: String(form.get("data_type")),
      externalId: String(form.get("external_id")),
      name: form.get("name") === null ? null : String(form.get("name")),
      filename: file.name,
    });
    return reply.code(201).send(uploadJson(upload));
  });

  app.get<{ Params: { id: string } }>("/api/v3/uploads/:id", (request, reply) => {
    const upload = world.pollUpload(Number(request.params.id));
    return upload === undefined
      ? reply.code(404).send({ message: "Not Found" })
      : uploadJson(upload);
  });

  app.get<{ Params: { uid: string } }>("/cdn/:uid", (request, reply) => {
    for (const a of world.activities.values()) {
      const photo = a.photos.find((p) => p.uniqueId === request.params.uid);
      if (photo !== undefined) return reply.type("image/png").send(photo.bytes);
    }
    return reply.code(404).send("missing");
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  return { apiBase: `${origin}/api/v3`, origin, close: () => app.close() };
}
