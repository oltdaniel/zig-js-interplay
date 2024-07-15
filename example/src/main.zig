const std = @import("std");
const ipl = @import("zig-js-interplay");

const js = ipl.js;

const AnyType = ipl.AnyType;
const Void = ipl.Void;
const Bool = ipl.Bool;
const Integer = ipl.Integer;
const UnsignedInteger = ipl.UnsignedInteger;
const Float = ipl.Float;
const String = ipl.String;
const Bytes = ipl.Bytes;
const JSON = ipl.JSON;
const Function = ipl.Function;
const Array = ipl.Array;

export fn greet(name: String) String {
    // Generate a new greet message that we can return
    const greetMessage = std.fmt.allocPrint(ipl.allocator, "Hello {s}!", .{name.value()}) catch @panic("Oops");
    // Return with Interplay String
    return ipl.String.init(greetMessage);
}

export fn blake2b(arg: String) String {
    const input = arg.value();

    var out: [32]u8 = undefined;

    std.crypto.hash.blake2.Blake2b256.hash(input, out[0..32], .{});

    const outHex = std.fmt.bytesToHex(out, .lower);

    const outHexPtr = ipl.allocator.alloc(u8, outHex.len) catch @panic("Oops");
    @memcpy(outHexPtr, &outHex);

    return String.init(outHexPtr);
}

export fn silence() void {
    _ = 1 + 1;
}

export fn testVoid() Void {
    return Void.init();
}

export fn printVoid(arg: Void) void {
    const message = std.fmt.allocPrint(ipl.allocator, "Void = {any}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

export fn testBool() Bool {
    return Bool.init(true);
}

export fn printBool(arg: Bool) void {
    const message = std.fmt.allocPrint(ipl.allocator, "Bool = {any}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

export fn testInt() Integer {
    return Integer.init(-12345);
}

export fn printInt(arg: Integer) void {
    const message = std.fmt.allocPrint(ipl.allocator, "Int = {any}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

export fn testUint() UnsignedInteger {
    return UnsignedInteger.init(12345);
}

export fn printUint(arg: UnsignedInteger) void {
    const message = std.fmt.allocPrint(ipl.allocator, "Uint = {any}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

export fn testFloat() Float {
    return Float.init(1.2345);
}

export fn printFloat(arg: Float) void {
    const message = std.fmt.allocPrint(ipl.allocator, "Float = {any}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

export fn testBytes() Bytes {
    return Bytes.init("Hello World");
}

export fn printBytes(arg: Bytes) void {
    const message = std.fmt.allocPrint(ipl.allocator, "Bytes = {any}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

export fn testString() String {
    return String.init("Bye World");
}

export fn printString(arg: String) void {
    const message = std.fmt.allocPrint(ipl.allocator, "String = {s}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

export fn testJSON() JSON {
    return JSON.init("{\"message\": \"Greetings\"}");
}

export fn printJSON(arg: JSON) void {
    const message = std.fmt.allocPrint(ipl.allocator, "JSON = {s}!", .{arg.value()}) catch @panic("Oops");
    js.log(String.init(message));
}

fn printHelloWorld(arg: Array) AnyType {
    const message = std.fmt.allocPrint(ipl.allocator, "This Zig function was passed as an argument and received {d} argument(s)!", .{arg.len}) catch @panic("Oops");

    js.log(String.init(message));

    return String.init("Zig says hi!").asAny();
}

export fn testFunctionRef() Function {
    return Function.init(printHelloWorld);
}

export fn testFunction(arg: Function) AnyType {
    const args = Array.from(&.{ String.init("Hello").asAny(), String.init("World").asAny() });
    return arg.call(args);
}

export fn testFunctionWithArgs(arg: Function, args: Array) AnyType {
    return arg.call(args);
}
