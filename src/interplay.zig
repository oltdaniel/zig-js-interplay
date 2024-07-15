const std = @import("std");

/// The internal allocator used by Interplay.
pub const allocator = std.heap.wasm_allocator;

// Expose the malloc function so we can pass large values
// from js to the wasm environment.
pub export fn malloc(length: usize) ?[*]u8 {
    const buf = allocator.alloc(u8, length) catch return null;

    return buf.ptr;
}

// Free memory that we have allocated from the JS space.
pub export fn free(buf: [*]u8, length: usize) void {
    allocator.free(buf[0..length]);
}

// Call a zig function by reference
pub export fn call(function: Function, args: Array) AnyType {
    if (function.origin != .zig) {
        @panic("Function to be executed in Zig expected to be of Zig origin.");
    }

    return function.call(args);
}

// External functions that are hooked in from the JS enviornment.
pub const js = struct {
    pub extern "js" fn log(arg: String) void;
    extern "js" fn call(function: Function, args: Array) AnyType;
};

pub const InterplayTypeId = enum(u4) { void = 0, bool = 1, int = 2, uint = 3, float = 4, bytes = 5, string = 6, json = 7, function = 8, array = 9 };

fn assertType(a: InterplayTypeId, b: InterplayTypeId) void {
    if (a != b) @panic("Mismatched type");
}

pub const InterplayType = u128;

pub const AnyType = packed struct(InterplayType) {
    type: InterplayTypeId,
    value: u124,
};

pub const Void = packed struct(InterplayType) {
    type: InterplayTypeId = .void,
    _: u124 = 0,

    pub fn init() @This() {
        return .{};
    }

    pub fn value(_: @This()) void {
        return undefined;
    }
};

pub const Bool = packed struct(InterplayType) {
    type: InterplayTypeId = .bool,
    v: bool,
    // Placeholder to keep fixed packed structs filled
    _: u123 = 0,

    pub fn init(v: bool) @This() {
        return .{
            .v = v,
        };
    }

    pub fn value(self: @This()) bool {
        assertType(self.type, .bool);
        return self.v;
    }

    pub fn asAny(self: @This()) AnyType {
        return @bitCast(self);
    }
};

fn bitFillerType(comptime size: usize) type {
    if (size > 0) {
        return [size]u1;
    }
    return void;
}

fn IntegerLikeType(comptime iplType: InterplayTypeId, comptime T: type) type {
    return packed struct(InterplayType) {
        type: InterplayTypeId = iplType,
        v: T,

        // Fill remaining bits
        _: bitFillerType(@bitSizeOf(InterplayType) - @bitSizeOf(InterplayTypeId) - @bitSizeOf(T)) = undefined,

        pub fn init(v: T) @This() {
            return .{
                .v = v,
            };
        }

        pub fn value(self: @This()) T {
            assertType(self.type, iplType);
            return self.v;
        }

        pub fn asAny(self: @This()) AnyType {
            return @bitCast(self);
        }
    };
}

pub const Integer = IntegerLikeType(.int, i124);
pub const UnsignedInteger = IntegerLikeType(.uint, u124);

pub const Float = packed struct(InterplayType) {
    type: InterplayTypeId = .float,
    v: f64,

    // Placeholder to keep fixed packed structs filled
    _: u60 = 0,

    pub fn init(v: f64) @This() {
        return .{
            .v = v,
        };
    }

    pub fn value(self: @This()) f64 {
        assertType(self.type, .float);
        return self.v;
    }

    pub fn asAny(self: @This()) AnyType {
        return @bitCast(self);
    }
};

pub fn BytesLike(comptime JsT: InterplayTypeId) type {
    return packed struct(InterplayType) {
        type: InterplayTypeId = JsT,
        // NOTE: WASM currently focuses on memory32 (this can be expanded in the future)
        // TODO: Make this dependent on the compile target (.wasm32 or .wasm64)
        //       -> this means probably .len needs to be cut 3bits for remaining type info
        ptr: u32,
        len: u32,

        // Placeholder to keep fixed packed structs filled
        _: u60 = 0,

        pub fn init(v: []const u8) @This() {
            return .{
                .ptr = @intFromPtr(v.ptr),
                .len = v.len,
            };
        }

        // Shortcut to easily access real value when received as an argument
        pub fn value(self: @This()) []const u8 {
            assertType(self.type, JsT);

            const vPtr: [*]u8 = @ptrFromInt(self.ptr);
            return vPtr[0..self.len];
        }

        pub fn asAny(self: @This()) AnyType {
            return @bitCast(self);
        }
    };
}

pub const Bytes = BytesLike(.bytes);

// In zig there isn't a difference
pub const String = BytesLike(.string);

// In zig there isn't a difference
// TODO: Maybe abstract this to offer builtin parsing when calling .value
//       For this we need a type argument for the json parser.
pub const JSON = BytesLike(.json);

pub const Function = packed struct(InterplayType) {
    type: InterplayTypeId = .function,

    ptr: usize,
    origin: enum(u1) { zig = 0, js = 1 },

    _: u91 = 0,

    const FunctionType = fn (args: Array) AnyType;

    pub fn init(function: FunctionType) @This() {
        return .{
            .ptr = @intFromPtr(&function),
            .origin = .zig,
        };
    }

    pub fn call(self: @This(), args: Array) AnyType {
        assertType(self.type, .function);

        if (self.origin == .zig) {
            const function: *const FunctionType = @ptrFromInt(self.ptr);
            return @call(.auto, function, .{args});
        } else {
            return js.call(self, args);
        }
    }

    pub fn asAny(self: @This()) AnyType {
        return @bitCast(self);
    }
};

pub const Array = packed struct(InterplayType) {
    type: InterplayTypeId = .array,
    ptr: usize = 0,
    len: usize = 0,
    _: u60 = 0,

    pub const empty: @This() = .{};

    pub fn init(capacity: usize) @This() {
        const ptr = allocator.alloc(AnyType, capacity) catch @panic("Oops");
        return .{
            .ptr = @intFromPtr(ptr.ptr),
            .len = capacity,
        };
    }

    pub fn from(arr: []const AnyType) @This() {
        const newArray = init(arr.len);
        for (arr, 0..) |el, i| {
            newArray.set(i, el);
        }
        return newArray;
    }

    pub fn set(self: @This(), index: usize, value: AnyType) void {
        const arr: [*]AnyType = @ptrFromInt(self.ptr);
        arr[index] = value;
    }

    pub fn get(self: @This(), index: usize) AnyType {
        const arr: [*]AnyType = @ptrFromInt(self.ptr);
        return arr[index];
    }

    pub fn asAny(self: @This()) AnyType {
        return @bitCast(self);
    }
};
