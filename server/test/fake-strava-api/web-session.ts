import { DeletionAuthorization } from "../../src/web/deletion-authorization.ts";
import {
  ChallengeError,
  LoginRequiredError,
  WebNotFoundError,
  WebUnexpectedResponseError,
} from "../../src/web/errors.ts";
import type { EditFormValues, Visibility } from "../../src/web/forms.ts";
import type {
  AttachPhotoInput,
  AttachPhotoResult,
  DeletionResult,
  DownloadedPhoto,
  EditForm,
  ExportedFile,
  StravaWebSession,
  WebHealth,
} from "../../src/web/session.ts";
import type { FakeWorld, WorldActivity } from "./world.ts";

/**
 * In-memory StravaWebSession over a FakeWorld, for the state machine tests.
 * It honours DeletionAuthorization exactly like the real session: the token
 * is consumed (single use, one activity, unexpired) before anything changes.
 */

export type DeleteMode =
  /** Delete and confirm. */
  | "normal"
  /** Delete, then the confirmation is lost: "sent but unconfirmed". */
  | "lose_confirmation"
  /** Claim success but delete nothing. */
  | "noop"
  /** Challenged before anything is sent. */
  | "challenge";

export class FakeWebSession implements StravaWebSession {
  readonly #world: FakeWorld;
  readonly #now: () => number;
  loggedIn = true;
  /** Whether login() succeeds. */
  loginWorks = false;
  deleteMode: DeleteMode = "normal";
  /** attachPhoto throws. */
  photoFails = false;
  /** attachPhoto succeeds but the photo is not listed afterwards. */
  photoUnverified = false;
  readonly calls: { op: string; id?: number }[] = [];
  readonly deleted: number[] = [];

  constructor(world: FakeWorld, now: () => number) {
    this.#world = world;
    this.#now = now;
  }

  #check(op: string, id?: number): void {
    this.calls.push(id === undefined ? { op } : { op, id });
    if (!this.loggedIn) throw new LoginRequiredError(`${op}: login required`);
  }

  #activity(id: number): WorldActivity {
    const activity = this.#world.get(id);
    if (activity === undefined) throw new WebNotFoundError(`/activities/${id}`);
    return activity;
  }

  #values(a: WorldActivity): EditFormValues {
    return {
      privateNote: a.privateNote,
      visibility: a.visibility,
      perceivedExertion: a.perceivedExertion,
      preferPerceivedExertion: a.preferPerceivedExertion,
      hideFromHome: a.hideFromHome,
    };
  }

  health(): Promise<WebHealth> {
    this.calls.push({ op: "health" });
    return Promise.resolve({
      loggedIn: this.loggedIn,
      reason: this.loggedIn ? null : "login_required",
      checkedAt: this.#now(),
    });
  }

  keepAlive(): Promise<WebHealth> {
    this.calls.push({ op: "keepalive" });
    return this.health();
  }

  login(): Promise<void> {
    this.calls.push({ op: "login" });
    if (!this.loginWorks) return Promise.reject(new LoginRequiredError("request_otp refused"));
    this.loggedIn = true;
    return Promise.resolve();
  }

  async exportOriginal(activityId: number): Promise<ExportedFile> {
    this.#check("export_original", activityId);
    const original = this.#activity(activityId).original;
    if (original === null) throw new WebNotFoundError(`/activities/${activityId}/export_original`);
    return {
      bytes: Buffer.from(original.bytes),
      filename: original.filename,
      contentType: "application/octet-stream",
    };
  }

  exportGpx(): Promise<ExportedFile> {
    return Promise.reject(new Error("not used by the state machine"));
  }

  async getEditForm(activityId: number): Promise<EditForm> {
    this.#check("edit_form", activityId);
    const a = this.#activity(activityId);
    return {
      activityId,
      csrfToken: "synthetic-csrf",
      authenticityToken: "synthetic-auth",
      entries: [],
      values: this.#values(a),
    };
  }

  async setVisibility(activityId: number, visibility: Visibility): Promise<EditFormValues> {
    this.#check("set_visibility", activityId);
    const a = this.#activity(activityId);
    a.visibility = visibility;
    return this.#values(a);
  }

  async setPrivateNote(activityId: number, text: string): Promise<EditFormValues> {
    this.#check("set_private_note", activityId);
    const a = this.#activity(activityId);
    a.privateNote = text;
    return this.#values(a);
  }

  async setPerceivedExertion(
    activityId: number,
    exertion: number | null,
    prefer = false,
  ): Promise<EditFormValues> {
    this.#check("set_exertion", activityId);
    const a = this.#activity(activityId);
    a.perceivedExertion = exertion;
    a.preferPerceivedExertion = prefer;
    return this.#values(a);
  }

  async deleteActivity(activityId: number, auth: DeletionAuthorization): Promise<DeletionResult> {
    this.calls.push({ op: "delete", id: activityId });
    DeletionAuthorization.consume(auth, activityId, this.#now());
    if (!this.loggedIn) throw new LoginRequiredError("delete: login required");
    if (this.deleteMode === "challenge") throw new ChallengeError("captcha", "delete challenged");
    const a = this.#activity(activityId);
    if (this.deleteMode === "noop") return { activityId, confirmedAt: this.#now() };
    a.exists = false;
    this.deleted.push(activityId);
    if (this.deleteMode === "lose_confirmation") {
      throw new LoginRequiredError(`delete of activity ${activityId} sent but unconfirmed`);
    }
    return { activityId, confirmedAt: this.#now() };
  }

  downloadPhoto(): Promise<DownloadedPhoto> {
    return Promise.reject(new Error("not used by the state machine"));
  }

  async attachPhoto(activityId: number, photo: AttachPhotoInput): Promise<AttachPhotoResult> {
    this.#check("attach_photo", activityId);
    if (this.photoFails) throw new WebUnexpectedResponseError("photo upload refused");
    const a = this.#activity(activityId);
    const uuid = `synthetic-attached-${a.photos.length + 1}`;
    if (!this.photoUnverified) {
      a.photos.push({ uniqueId: uuid, bytes: photo.bytes, createdAt: photo.takenAt.toISOString() });
    }
    return { uuid, verified: !this.photoUnverified };
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }
}
