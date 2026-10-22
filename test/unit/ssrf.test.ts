import { describe, expect, it } from "vitest";
import {
  isPrivateOrReservedIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  resolveAndValidateHost,
  validateUrl,
} from "../../src/connectors/ssrf.js";
import { SyncError } from "../../src/core/types.js";

describe("SSRF guard", () => {
  describe("IPv4 range classification", () => {
    it("flags private and loopback IPv4 addresses as unsafe", () => {
      expect(isPrivateOrReservedIpv4("127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("127.255.255.255")).toBe(true);
      expect(isPrivateOrReservedIpv4("10.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("10.255.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("172.16.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("172.31.255.255")).toBe(true);
      expect(isPrivateOrReservedIpv4("192.168.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("192.168.100.254")).toBe(true);
    });

    it("flags link-local and cloud metadata addresses as unsafe", () => {
      expect(isPrivateOrReservedIpv4("169.254.169.254")).toBe(true);
      expect(isPrivateOrReservedIpv4("169.254.1.1")).toBe(true);
    });

    it("flags carrier-grade NAT and reserved multicast ranges as unsafe", () => {
      expect(isPrivateOrReservedIpv4("100.64.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("0.0.0.0")).toBe(true);
      expect(isPrivateOrReservedIpv4("224.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("240.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("255.255.255.255")).toBe(true);
    });

    it("identifies public IPv4 addresses as safe", () => {
      expect(isPrivateOrReservedIpv4("8.8.8.8")).toBe(false);
      expect(isPrivateOrReservedIpv4("1.1.1.1")).toBe(false);
      expect(isPrivateOrReservedIpv4("93.184.216.34")).toBe(false);
      expect(isPrivateOrReservedIpv4("172.32.0.1")).toBe(false); // Outside 172.16-31
      expect(isPrivateOrReservedIpv4("192.169.0.1")).toBe(false); // Outside 192.168
    });
  });

  describe("IPv6 range classification", () => {
    it("flags loopback, unique local, and link-local IPv6 addresses as unsafe", () => {
      expect(isPrivateOrReservedIpv6("::1")).toBe(true);
      expect(isPrivateOrReservedIpv6("::")).toBe(true);
      expect(isPrivateOrReservedIpv6("fc00::1")).toBe(true);
      expect(isPrivateOrReservedIpv6("fd12:3456::1")).toBe(true);
      expect(isPrivateOrReservedIpv6("fe80::1")).toBe(true);
      expect(isPrivateOrReservedIpv6("ff02::1")).toBe(true); // multicast
    });

    it("flags IPv4-mapped IPv6 addresses targeting private networks", () => {
      expect(isPrivateOrReservedIpv6("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv6("::ffff:192.168.1.1")).toBe(true);
      expect(isPrivateOrReservedIpv6("::ffff:169.254.169.254")).toBe(true);
      expect(isPrivateOrReservedIpv6("::ffff:8.8.8.8")).toBe(false);
    });

    it("generic isPrivateOrReservedIp detects valid/invalid IPs", () => {
      expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
      expect(isPrivateOrReservedIp("not-an-ip")).toBe(true);
    });
  });

  describe("validateUrl", () => {
    it("requires https by default and rejects http", () => {
      expect(() => validateUrl("http://api.example.com/data")).toThrowError(SyncError);
      expect(() => validateUrl("http://api.example.com/data")).toThrow(/https:\/\/ is required/);
      expect(() => validateUrl("ftp://api.example.com/data")).toThrow(/unsupported protocol/);
    });

    it("allows http when allowHttp is explicitly set", () => {
      const url = validateUrl("http://api.example.com/data", { allowHttp: true });
      expect(url.protocol).toBe("http:");
      expect(url.hostname).toBe("api.example.com");
    });

    it("enforces allowedHosts when specified", () => {
      expect(() =>
        validateUrl("https://evil.com/data", { allowedHosts: ["api.example.com"] }),
      ).toThrowError(/not in allowedHosts list/);

      const valid = validateUrl("https://api.example.com/data", { allowedHosts: ["api.example.com"] });
      expect(valid.hostname).toBe("api.example.com");
    });

    it("rejects cloud metadata hostnames", () => {
      expect(() =>
        validateUrl("https://metadata.google.internal/computeMetadata/v1", { allowPrivateNetworks: false }),
      ).toThrow(/access to metadata host/);
    });
  });

  describe("resolveAndValidateHost", () => {
    it("rejects direct private IPs if allowPrivateNetworks is false", async () => {
      await expect(
        resolveAndValidateHost("127.0.0.1", { allowPrivateNetworks: false }),
      ).rejects.toThrowError(/private or reserved range/);

      await expect(
        resolveAndValidateHost("169.254.169.254", { allowPrivateNetworks: false }),
      ).rejects.toThrowError(/private or reserved range/);
    });

    it("allows private IPs when allowPrivateNetworks is true", async () => {
      const resolved = await resolveAndValidateHost("127.0.0.1", { allowPrivateNetworks: true });
      expect(resolved).toBe("127.0.0.1");
    });

    it("rejects localhost hostname when allowPrivateNetworks is false", async () => {
      await expect(
        resolveAndValidateHost("localhost", { allowPrivateNetworks: false }),
      ).rejects.toThrowError(/localhost/);
    });
  });
});
