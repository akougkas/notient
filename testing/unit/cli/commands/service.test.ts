import { describe, expect, test } from "bun:test";
import { launchdPlist, systemdUnit } from "../../../../src/cli/commands/service";
const input = {
  vaultPath: '/tmp/Notes with "quotes" % and $dollars',
  bunPath: "/usr/bin/bun",
  daemonEntry: "/opt/notient/daemon.js",
  executablePath: "/usr/bin:/bin",
};
describe("user service definitions", () => {
  test("systemd keeps path arguments literal, isolates dotenv and owns its child group", () => {
    const unit = systemdUnit(input);
    expect(unit).toContain("--env-file=/dev/null");
    expect(unit).toContain('"/tmp/Notes with \\"quotes\\" %% and $$dollars"');
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain("UMask=0077");
  });
  test("launchd uses an argument array and XML-escapes vault paths", () => {
    const plist = launchdPlist({ ...input, vaultPath: "/tmp/Research & <drafts>" });
    expect(plist).toContain("<key>ProgramArguments</key><array>");
    expect(plist).toContain("<string>/tmp/Research &amp; &lt;drafts&gt;</string>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
  });
  test("refuses line injection into either manager format", () => {
    expect(() => systemdUnit({ ...input, vaultPath: "/tmp/a\nExecStart=/bin/false" })).toThrow();
    expect(() => launchdPlist({ ...input, executablePath: "/bin\0/usr/bin" })).toThrow();
  });
});
