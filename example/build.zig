const std = @import("std");

// Although this function looks imperative, note that its job is to
// declaratively construct a build graph that will be executed by an external
// runner.
pub fn build(b: *std.Build) void {
    // The optimize flag, default ReleaseSmall to have a small binary.
    // Using .ReleaseSafe and .ReleaseFast will multiply the binary output size drastically.
    const optimize = .ReleaseSmall;

    // NOTE: This WASM target enables all features that all major browsers support.
    //       If there is the need to reduce these feature sets to support other environments
    //       any feature can be deactivated. This library itself does not rely on any specific
    //       features.
    // WASM Feature support can be tested/viewed here: https://webassembly.org/features/
    // The corresponding features for zig are documented here: https://ziglang.org/documentation/master/std/#std.Target.wasm.Feature
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = std.Target.wasm.featureSet(&.{
            .atomics,
            .bulk_memory,
            .exception_handling,
            .extended_const,
            // .multimemory, // not supported by Safari
            .multivalue,
            .mutable_globals,
            .nontrapping_fptoint,
            .reference_types,
            // .relaxed_simd, // not supported by Firefox or Safari
            .sign_ext,
            .simd128,
            // .tail_call, // not supported by Safari
        }),
    });

    const wasm = b.addExecutable(.{
        .name = "main",
        // In this case the main source file is merely a path, however, in more
        // complicated build scripts, this could be a generated file.
        .root_source_file = b.path("src/main.zig"),
        .target = wasm_target,
        .optimize = optimize,
    });

    // Load depdendency
    const zigJsInterplay = b.dependency("zig-js-interplay", .{});

    // Add dependency to root module
    wasm.root_module.addImport("zig-js-interplay", zigJsInterplay.module("zig-js-interplay"));

    // Some WASM specific flags
    wasm.entry = .disabled; // disables entry point
    wasm.rdynamic = true; // expose exported functions to environment
    wasm.max_memory = std.wasm.page_size * 100; // allow for some allocation headroom

    // This declares intent for the wasmrary to be installed into the standard
    // location when the user invokes the "install" step (the default step when
    // running `zig build`).
    b.getInstallStep().dependOn(&b.addInstallFile(wasm.getEmittedBin(), "../main.wasm").step);
}
