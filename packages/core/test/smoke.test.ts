import { expect, test } from "bun:test";
import { CORE_VERSION } from "../src/index";
test("core loads", () => { expect(CORE_VERSION).toBe("0.1.0"); });
