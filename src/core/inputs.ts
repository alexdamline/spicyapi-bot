import type { MediaKind } from "./store.js";

type JsonSchema = {
  type?: unknown;
  properties?: Record<string, PropertySchema>;
  required?: unknown;
};

type PropertySchema = {
  type?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  format?: string;
  "x-ui"?: { widget?: string; primary?: boolean };
};

export interface InputSettings {
  prompt: string;
  /** Required for animate: an https:// or spicy:// image address. */
  imageUrl?: string;
  /** Preferred video length; clamped to what the model accepts. */
  videoSeconds?: number;
  /** Preferred resolution such as "480p"; ignored when the model does not offer it. */
  videoResolution?: string;
  /** Preferred aspect ratio such as "16:9"; ignored when the model does not offer it. */
  aspectRatio?: string;
}

export class InputError extends Error {
  override name = "InputError";
}

const PROMPT_FIELDS = ["prompt"];
const IMAGE_FIELDS = ["image_url", "first_frame_url", "image", "start_image_url"];
const DURATION_FIELDS = ["duration_seconds", "duration"];

function properties(schema: unknown): Record<string, PropertySchema> {
  const props = (schema as JsonSchema | undefined)?.properties;
  return props && typeof props === "object" ? props : {};
}

function requiredFields(schema: unknown): string[] {
  const required = (schema as JsonSchema | undefined)?.required;
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function promptField(props: Record<string, PropertySchema>): string | undefined {
  const named = PROMPT_FIELDS.find((name) => props[name]);
  if (named) return named;
  return Object.entries(props).find(([, prop]) => prop.type === "string" && prop["x-ui"]?.primary)?.[0];
}

/** The field that takes the starting image of an image-to-video model. */
export function imageField(schema: unknown): string | undefined {
  const props = properties(schema);
  const required = requiredFields(schema);
  const named = IMAGE_FIELDS.find((name) => props[name]);
  if (named) return named;
  const isImageUpload = ([name, prop]: [string, PropertySchema]) =>
    prop.type === "string" && name.includes("image") && !name.includes("last") && (prop.format === "uri" || prop["x-ui"]?.widget === "upload");
  const entries = Object.entries(props);
  return entries.find((entry) => required.includes(entry[0]) && isImageUpload(entry))?.[0] ?? entries.find(isImageUpload)?.[0];
}

/** Picks the allowed value closest to the wish, preferring the shorter one on a tie. */
export function clampSeconds(prop: PropertySchema, wanted: number): number {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const options = prop.enum.filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
    if (options.length > 0) {
      let best = options[0]!;
      for (const option of options) if (Math.abs(option - wanted) < Math.abs(best - wanted)) best = option;
      return best;
    }
  }
  let value = wanted;
  if (typeof prop.minimum === "number") value = Math.max(value, prop.minimum);
  if (typeof prop.maximum === "number") value = Math.min(value, prop.maximum);
  return prop.type === "integer" ? Math.round(value) : value;
}

function enumHas(prop: PropertySchema | undefined, value: string | undefined): value is string {
  return value !== undefined && Array.isArray(prop?.enum) && prop.enum.includes(value);
}

/**
 * Builds `createTask.input` for one of the bot's three media actions from the model's own schema,
 * so switching models never needs code changes. Only fields the schema declares are sent; anything
 * not set here keeps the model's default.
 */
export function buildMediaInput(kind: MediaKind, schema: unknown, settings: InputSettings): Record<string, unknown> {
  const props = properties(schema);
  const prompt = settings.prompt.trim();
  if (!prompt) throw new InputError("Please add a prompt.");
  const promptName = promptField(props);
  if (!promptName) throw new InputError("This model does not take a text prompt, so the bot cannot drive it. Pick another model.");

  const input: Record<string, unknown> = { [promptName]: prompt };

  if (kind === "animate") {
    const name = imageField(schema);
    if (!name) throw new InputError("This model has no starting-image input. Pick an image-to-video model.");
    if (!settings.imageUrl) throw new InputError("An image is needed to animate.");
    input[name] = settings.imageUrl;
  }

  if (kind === "video" || kind === "animate") {
    const durationName = DURATION_FIELDS.find((name) => props[name]);
    if (durationName && settings.videoSeconds !== undefined) {
      input[durationName] = clampSeconds(props[durationName]!, settings.videoSeconds);
    }
    if (enumHas(props.resolution, settings.videoResolution)) input.resolution = settings.videoResolution;
  }

  // An image-to-video model follows the shape of its starting image, so only text prompts get a ratio.
  if (kind !== "animate" && enumHas(props.aspect_ratio, settings.aspectRatio)) input.aspect_ratio = settings.aspectRatio;

  return input;
}
