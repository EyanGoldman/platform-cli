import { afterEach, describe, expect, it } from "vitest";
import { resetKeychain, setKeychain, getKeychain, type Keychain } from "../src/keychain.js";

class InMemoryKeychain implements Keychain {
  private store = new Map<string, string>();
  private key(s: string, a: string): string {
    return `${s}::${a}`;
  }
  getSecret(service: string, account: string): string | null {
    return this.store.get(this.key(service, account)) ?? null;
  }
  setSecret(service: string, account: string, value: string): void {
    this.store.set(this.key(service, account), value);
  }
  deleteSecret(service: string, account: string): void {
    this.store.delete(this.key(service, account));
  }
}

describe("getKeychain (test seam)", () => {
  afterEach(() => resetKeychain());

  it("returns the substituted instance after setKeychain", () => {
    const fake = new InMemoryKeychain();
    setKeychain(fake);
    expect(getKeychain()).toBe(fake);
  });

  it("set/get/delete round-trips against the in-memory fake", () => {
    const fake = new InMemoryKeychain();
    setKeychain(fake);
    fake.setSecret("svc", "acct", "value");
    expect(getKeychain().getSecret("svc", "acct")).toBe("value");
    fake.deleteSecret("svc", "acct");
    expect(getKeychain().getSecret("svc", "acct")).toBeNull();
  });
});
