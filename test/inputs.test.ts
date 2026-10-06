import { describe, expect, it } from "vitest";
import { buildMediaInput, clampSeconds, imageField, InputError } from "../src/core/inputs.js";
import { I2V_SCHEMA, IMAGE_SCHEMA } from "./fakes.js";

describe("buildMediaInput", () => {
  it("sends the prompt and only options the model declares", () => {
    expect(buildMediaInput("image", IMAGE_SCHEMA, { prompt: "  a red kite  ", aspectRatio: "16:9", videoSeconds: 5 })).toEqual({
      prompt: "a red kite",
      aspect_ratio: "16:9",
    });
  });

  it("leaves an unsupported ratio to the model default", () => {
    expect(buildMediaInput("image", IMAGE_SCHEMA, { prompt: "x", aspectRatio: "21:9" })).toEqual({ prompt: "x" });
  });

  it("fills the starting image, clamps the duration and picks the resolution for image-to-video", () => {
    const input = buildMediaInput("animate", I2V_SCHEMA, {
      prompt: "slow push-in",
      imageUrl: "spicy://f/fil_1",
      videoSeconds: 2,
      videoResolution: "480p",
      aspectRatio: "16:9",
    });
    expect(input).toEqual({ prompt: "slow push-in", image_url: "spicy://f/fil_1", duration_seconds: 4, resolution: "480p" });
  });

  it("ignores a resolution the model does not offer", () => {
    const input = buildMediaInput("animate", I2V_SCHEMA, { prompt: "x", imageUrl: "https://example.test/a.png", videoResolution: "4k", videoSeconds: 30 });
    expect(input).toEqual({ prompt: "x", image_url: "https://example.test/a.png", duration_seconds: 15 });
  });

  it("explains what is missing", () => {
    expect(() => buildMediaInput("image", IMAGE_SCHEMA, { prompt: "   " })).toThrow(InputError);
    expect(() => buildMediaInput("animate", I2V_SCHEMA, { prompt: "x" })).toThrow(/image is needed/);
    expect(() => buildMediaInput("animate", IMAGE_SCHEMA, { prompt: "x", imageUrl: "spicy://f/1" })).toThrow(/starting-image/);
    expect(() => buildMediaInput("image", { properties: { image_url: { type: "string" } } }, { prompt: "x" })).toThrow(/text prompt/);
  });
});

describe("schema helpers", () => {
  it("finds the starting image field and never the last frame", () => {
    expect(imageField(I2V_SCHEMA)).toBe("image_url");
    expect(
      imageField({
        required: ["prompt", "start_frame_image"],
        properties: { last_frame_image: { type: "string", format: "uri" }, start_frame_image: { type: "string", format: "uri" } },
      }),
    ).toBe("start_frame_image");
  });

  it("snaps to the nearest allowed duration", () => {
    expect(clampSeconds({ enum: [5, 10] }, 7)).toBe(5);
    expect(clampSeconds({ enum: [5, 10] }, 8)).toBe(10);
    expect(clampSeconds({ type: "integer", minimum: 4, maximum: 12 }, 5)).toBe(5);
  });
});
