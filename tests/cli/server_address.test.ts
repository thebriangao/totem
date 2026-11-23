// The own-server address: what totem cloud accepts and how it tidies it.
import { describe, expect, it } from "vitest";
import { serverAddress } from "../../src/cli/setup.js";
import { dockerBuildArgs, installVersion } from "../../src/cli/deploy_record.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("serverAddress", () => {
  it("takes any http(s) address with a host, local and home-network names included", () => {
    expect(serverAddress("https://totem.example.com")).toBe("https://totem.example.com");
    expect(serverAddress("totem.example.com")).toBe("https://totem.example.com");
    expect(serverAddress("http://localhost:3000")).toBe("http://localhost:3000");
    expect(serverAddress("http://homeserver:3000")).toBe("http://homeserver:3000");
    expect(serverAddress("http://127.0.0.1:3999")).toBe("http://127.0.0.1:3999");
    expect(serverAddress("http://192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
    expect(serverAddress("https://example.com/totem")).toBe("https://example.com/totem");
  });

  it("drops a trailing /mcp or slash: the server adds /mcp itself", () => {
    expect(serverAddress("https://totem.example.com/mcp")).toBe("https://totem.example.com");
    expect(serverAddress("https://totem.example.com/mcp/")).toBe("https://totem.example.com");
    expect(serverAddress("  https://totem.example.com/  ")).toBe("https://totem.example.com");
  });

  it("refuses what isn't a plain web address", () => {
    for (const bad of ["", "   ", "ftp://totem.example.com", "https://user:pw@totem.example.com", "https://totem.example.com/?x=1", "https://totem.example.com/#a", "not a url", "https://"]) {
      expect(serverAddress(bad), bad).toBeNull();
    }
  });
});

describe("dockerBuildArgs", () => {
  it("sets the build id to the install's version, and leaves it out when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "totem-build-"));
    expect(installVersion(root)).toBeNull();
    expect(dockerBuildArgs(root)).toEqual(["docker", "build", "-t", "totem"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
    expect(dockerBuildArgs(root)).toEqual(["docker", "build", "--build-arg", "TOTEM_BUILD_ID=2.0.0", "-t", "totem"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0; rm -rf ~" }));
    expect(installVersion(root)).toBeNull();
  });
});
