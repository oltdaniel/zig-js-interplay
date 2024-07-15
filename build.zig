const std = @import("std");

pub fn build(b: *std.Build) void {
    _ = b.addModule("zig-js-interplay", .{
        .root_source_file = b.path("src/interplay.zig"),
    });
}
