// src/interplay.ts
var InterplayInstance = class {
  /**
   * Hold the exports of the WASM instance. This is the core of this wrapper functionality.
   */
  #wasm = void 0;
  /**
   * Central Text Decoder instance for converting bytes to string.
   */
  #textDecoder = new TextDecoder();
  /**
   * Central Text Encoder instance for converting string to bytes.
   */
  #textEncoder = new TextEncoder();
  /**
   * Table to assign a number to a JavaScript function in order to remember
   * it by an unique id and being able to call it again if necessary.
   */
  #functionTable = {};
  /**
   * Initialize a new Wrapper instance from an url which is loaded in async via fetch.
   * 
   * @param wasmUrl URL to given wasm file that should be loaded
   * @returns new instance of the ZigWASMWrapper for this wasm file
   */
  static async initializeFromUrl(wasmUrl) {
    const rawWasm = await fetch(wasmUrl).then((resp) => resp.arrayBuffer());
    return this.initialize(rawWasm);
  }
  /**
   * Initialize a new Wrapper directly from the raw WASM bytes.
   * 
   * @param rawModule raw bytes of the wasm module to initialize
   * @returns new instance of the ZigWASMWrapper for this wasm file
   */
  static async initialize(rawModule) {
    const inst = new this();
    const obj = await WebAssembly.instantiate(rawModule, {
      js: {
        log: (arg, arg2) => {
          let message = inst.#decodeInterplayType([arg, arg2]).value;
          console.log(message);
        },
        call: (func, func2, args, args2) => {
          let f = inst.#decodeInterplayType([func, func2]).value;
          if (Object.getPrototypeOf(f).origin != 1) {
            throw new Error("Function to be executed in JS expected to be of JS origin.");
          }
          let a = inst.#decodeInterplayType([args, args2]).value;
          return inst.#encodeInterplayType(f(...a));
        }
      }
    });
    inst.#loadWasmObj(obj);
    return inst;
  }
  constructor() {
  }
  /**
   * This function does some initialization for a loaded WASM module and raises the WASM exports to functions directly
   * accessible from this very class instance via the interplay wrapper.
   * 
   * @param obj the instantiated WASM source for which this class has been created
   */
  #loadWasmObj(obj) {
    this.#wasm = obj.instance.exports;
    for (let name of Object.keys(this.#wasm).filter((n) => !["malloc", "free", "memory", "call"].includes(n))) {
      if (typeof this.#wasm[name] !== "function") {
        console.warn("We currently only make exported functions accessible through the Interplay Wrapper.");
        continue;
      }
      this[name] = this.#wrappedCallHandler(name);
    }
  }
  /**
   * This not only returns a wrapped function handler, it also checks of the actual export is even a function that we could
   * call. This should only be called if the caller is sure, the named export is actually a function.
   * 
   * @param funcName name of the exported wasm function to wrap
   * @returns handler function for a wrapped call to the named function
   */
  #wrappedCallHandler(funcName) {
    const wasmFunc = this.#wasm[funcName];
    if (typeof wasmFunc !== "function") throw new Error("WASM export is not callable!");
    return (...args) => {
      return this.#wrappedCall(wasmFunc, ...args);
    };
  }
  /**
   * This function abstracts the complexity of calling a WASM exported function directly with JavaScript values of any kind
   * without thinking about the Interplay Types. The arguments will be automatically converted and the return will be
   * parsed. This means, there is no need to think about Interplay Types outside of these wrapped calls.
   * 
   * It is important to not ate this point, allocated resources for converting JavaScript values to Interplay Types will be
   * automatically freed after the call to the underlying WASM function finished. Values used within the WASM module after
   * their use within the function block, should not be done. Instead a full copy of that value is necessary.
   * 
   * @param func name of the function from the WASM exports
   * @param args arguments that should be converted to Interplay Types
   * @returns parsed Interplay Type from the return value of that function
   */
  #wrappedCall(func, ...args) {
    const wasmArgs = args.map((a) => this.#encodeInterplayType(a));
    const r = func(...wasmArgs.flat());
    for (let i = 0; i < wasmArgs.length; i++) {
      this.#freeEncodedInterplayType(wasmArgs[i]);
    }
    const wasmReturn = r ? this.#decodeInterplayType(r).value : void 0;
    if (wasmReturn) {
      this.#freeEncodedInterplayType(r);
    }
    return wasmReturn;
  }
  /**
   * Each InterplayType in Zig is a packed struct of size u128 of which the first 4bit are its type notation. The
   * reamaining bits can be used as desired for each type, requireing to parse different sections of different use
   * and size. This function abstracts this to avoid repeating code but introducing a small performance penalty.
   * 
   * @param value the raw value of bits from where the section values will be extracted
   * @param sections the sections in which exact order their values of X bits will be extracted
   * @returns an object with the section name as key and extracted bits as value
   */
  #extractBitSections(value, sections) {
    const r = {};
    let bits = value;
    for (const section of sections) {
      r[section[0]] = BigInt.asUintN(section[1], bits);
      bits >>= BigInt(section[1]);
    }
    return r;
  }
  // TODO: Implement this to avoid weird lines of code for encoding
  #packBitSections(sections) {
    return 0n;
  }
  /**
   * Detect the correct InterplayTypeId for any JS value. If the type is not supported, we throw an error.
   * 
   * @param value the value of which the InterplayTypeId should be detected from
   * @returns the detected InterplayTypeId
   */
  #mapValueToInterplayTypeId(value) {
    switch (typeof value) {
      case "string":
        return 6 /* string */;
      case "number":
        return value % 1 === 0 ? value < 0 ? 2 /* int */ : 3 /* uint */ : 4 /* float */;
      case "bigint":
        return value < 0n ? 2 /* int */ : 3 /* uint */;
      case "boolean":
        return 1 /* bool */;
      case "symbol":
        throw new Error(`type '${typeof value}' (value '${String(value)}') not implemented`);
      case "undefined":
        return 0 /* void */;
      case "object": {
        if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
          return 5 /* bytes */;
        }
        if (Array.isArray(value)) {
          return 9 /* array */;
        }
        return 7 /* json */;
      }
      case "function":
        return 8 /* function */;
      default:
        throw new Error(`type '${typeof value}' not implemented`);
    }
  }
  /**
   * Decode a given Interplay Type to its JavaScript value. Any allocations done to the interplay type can be freed
   * after this call, as the return value does not depend on the origin value.
   * 
   * @param value interplay type to decode
   * @returns decoded interplay type as javascript value
   */
  #decodeInterplayType(value) {
    const ipl = BigInt.asUintN(64, value[0]) | BigInt.asUintN(64, value[1]) << 64n;
    const { type, details } = this.#extractBitSections(ipl, [
      ["type", 4],
      ["details", 124]
    ]);
    switch (Number(type)) {
      case 0 /* void */:
        return { type };
      case 1 /* bool */:
        return { type, value: (details & 0x1n) == 1n ? true : false };
      case 2 /* int */:
        return { type, value: BigInt.asIntN(124, details) };
      case 3 /* uint */:
        return { type, value: BigInt.asUintN(124, details) };
      case 4 /* float */: {
        const rawFloatValue = BigInt.asUintN(64, details);
        const tempBuf = new ArrayBuffer(8);
        const tempBufView = new DataView(tempBuf);
        tempBufView.setBigUint64(0, rawFloatValue);
        return { type, value: tempBufView.getFloat64(0) };
      }
      case 5 /* bytes */: {
        const buf = this.#decodeBytesLikeType(details);
        return { type, value: buf.slice() };
      }
      case 6 /* string */: {
        const buf = this.#decodeBytesLikeType(details);
        const str = this.#textDecoder.decode(buf);
        return { type, value: str };
      }
      case 7 /* json */: {
        const buf = this.#decodeBytesLikeType(details);
        const str = this.#textDecoder.decode(buf);
        const json = JSON.parse(str);
        return { type, value: json };
      }
      case 8 /* function */: {
        const f = function(...args) {
          if (this.prototype.origin == 1) {
            return this.prototype.inst.#functionTable[this.prototype.ptr](args);
          } else {
            return this.prototype.inst.#wrappedCall(this.prototype.inst.#wasm.call, this, args);
          }
        };
        const { ptr, origin } = this.#extractBitSections(details, [
          ["ptr", 32],
          ["origin", 1]
        ]);
        f.prototype.ptr = ptr;
        f.prototype.origin = origin;
        f.prototype.inst = this;
        const boundF = f.bind(f);
        Object.setPrototypeOf(boundF, f.prototype);
        return { type, value: boundF };
      }
      case 9 /* array */: {
        const { ptr, len } = this.#extractBitSections(details, [
          ["ptr", 32],
          ["len", 32]
        ]);
        const tempBuf = new BigUint64Array(this.#wasm.memory.buffer, Number(ptr), Number(len * 2n));
        const decodedArray = [];
        for (let i = 0; i < len; i++) {
          const iplVariable = Array.from(tempBuf.subarray(i * 2, (i + 1) * 2));
          const variable = this.#decodeInterplayType(iplVariable);
          decodedArray.push(variable.value);
        }
        return { type, value: decodedArray };
      }
      default:
        throw new Error(`Interplay type ${type} is not supported for decoding.`);
    }
  }
  /**
   * Encode a JavaScript value to the corresponding interplay type. This may require allocation in memory in order to
   * transfer the full value to the WASM environment. There is no automatic free and this needs to be done manually
   * after the interplay type has been used.
   * 
   * @param value javascript value to encode
   * @returns encoded javascript value as interplay type
   */
  #encodeInterplayType(value) {
    const iplType = this.#mapValueToInterplayTypeId(value);
    let iplValue = 0n;
    switch (iplType) {
      case 0 /* void */:
        break;
      case 1 /* bool */:
      case 2 /* int */:
      case 3 /* uint */:
        iplValue = BigInt.asUintN(124, BigInt(value));
        break;
      case 4 /* float */: {
        const tempBuf = new ArrayBuffer(8);
        const tempBufView = new DataView(tempBuf);
        tempBufView.setFloat64(0, value);
        iplValue = tempBufView.getBigUint64(0);
        break;
      }
      case 5 /* bytes */: {
        const buf = value instanceof Uint8Array ? value : new Uint8Array(value);
        iplValue = this.#encodeBytesLikeType(buf);
        break;
      }
      case 6 /* string */: {
        const buf = this.#textEncoder.encode(value);
        iplValue = this.#encodeBytesLikeType(buf);
        break;
      }
      case 7 /* json */: {
        const buf = this.#textEncoder.encode(JSON.stringify(value));
        iplValue = this.#encodeBytesLikeType(buf);
        break;
      }
      case 8 /* function */: {
        if (value.prototype && Object.hasOwn(value.prototype, "origin") && Object.hasOwn(value.prototype, "ptr") && value.prototype.origin == 0) {
          iplValue = BigInt.asUintN(1, value.prototype.origin) << 32n | BigInt.asUintN(32, value.prototype.ptr);
        } else {
          const key = Object.keys(this.#functionTable).length;
          this.#functionTable[key] = (args) => {
            return value(...args);
          };
          iplValue = BigInt.asUintN(1, 1n) << 32n | BigInt.asUintN(32, BigInt(key));
        }
        break;
      }
      case 9 /* array */: {
        if (value.length == 0) break;
        const bufLen = value.length * 16;
        const ptr = this.#wasm.malloc(bufLen);
        const tempBuf = new BigUint64Array(this.#wasm.memory.buffer, ptr, bufLen);
        for (let i = 0; i < value.length; i++) {
          const encodedEl = this.#encodeInterplayType(value[i]);
          tempBuf[i * 2] = encodedEl[0];
          tempBuf[i * 2 + 1] = encodedEl[1];
        }
        iplValue = BigInt.asUintN(32, BigInt(value.length)) << 32n | BigInt.asUintN(32, BigInt(ptr));
        break;
      }
      default:
        throw new Error(`Interplay type ${iplType} is not supported for encoding.`);
    }
    let fullInfo = BigInt.asUintN(4, BigInt(iplType)) | BigInt.asUintN(124, BigInt(iplValue)) << 4n;
    let r = [BigInt.asUintN(64, fullInfo), BigInt.asUintN(64, fullInfo >> 64n)];
    return r;
  }
  /**
   * This is a shortcut to easily read bytes like interplay types from memory. It is important to note, that this function
   * does no return a copy of the memory section, but rather points at it. If you return this and modify it without the purpose
   * of modifying it in the actual memory, please create a copy of this buffer.
   * 
   * @param value interplay type that implements the bytes like interface
   * @returns the buffer pointing to the memory section
   */
  #decodeBytesLikeType(value) {
    const { ptr, len } = this.#extractBitSections(value, [
      ["ptr", 32],
      ["len", 32]
    ]);
    return new Uint8Array(this.#wasm.memory.buffer, Number(ptr), Number(len));
  }
  /**
   * This is a shortcut to easily copy bytes like interplay types to memory. This copies the given buffer and the given buffer
   * is free to be cleared/freed or used otherwise after this call.
   * 
   * @param buf to copy as bytes like interplay type to wasm memory
   * @returns encoded interplay type for this buffer
   */
  #encodeBytesLikeType(buf) {
    const len = buf.byteLength;
    const ptr = this.#wasm.malloc(len);
    new Uint8Array(this.#wasm.memory.buffer, ptr, len).set(buf);
    return BigInt.asUintN(32, BigInt(len)) << 32n | BigInt.asUintN(32, BigInt(ptr));
  }
  /**
   * As soon as a call to the WASM function os over or the return has been decoded into a JavaScript value, any allocations
   * done for those types, on both Zig and JS side, will be freed with this function.
   * 
   * @param value the interplay type to free the allocated resources for
   */
  #freeEncodedInterplayType(value) {
    const ipl = BigInt.asUintN(64, value[0]) | BigInt.asUintN(64, value[1]) << 64n;
    const { type, details } = this.#extractBitSections(ipl, [
      ["type", 4],
      ["details", 124]
    ]);
    switch (Number(type)) {
      case 0 /* void */:
      case 1 /* bool */:
      case 2 /* int */:
      case 3 /* uint */:
      case 4 /* float */:
        break;
      case 5 /* bytes */:
      case 6 /* string */:
      case 7 /* json */: {
        const { ptr, len } = this.#extractBitSections(details, [
          ["ptr", 32],
          ["len", 32]
        ]);
        this.#wasm.free(Number(ptr), Number(len));
        break;
      }
      case 8 /* function */: {
        const { ptr, origin } = this.#extractBitSections(details, [
          ["ptr", 32],
          ["origin", 1]
        ]);
        if (origin === 1n) {
          delete this.#functionTable[Number(ptr)];
        }
        break;
      }
      case 9 /* array */: {
        const { ptr, len } = this.#extractBitSections(details, [
          ["ptr", 32],
          ["len", 32]
        ]);
        const tempBuf = new BigUint64Array(this.#wasm.memory.buffer, Number(ptr), Number(len * 2n));
        for (let i = 0; i < len; i++) {
          const iplVariable = Array.from(tempBuf.subarray(i * 2, (i + 1) * 2));
          this.#freeEncodedInterplayType(iplVariable);
        }
        this.#wasm.free(Number(ptr), Number(len * 16n));
        break;
      }
      default:
        throw new Error(`Interplay type ${type} is not supported for decoding.`);
    }
  }
};
var InterplayTypeId = /* @__PURE__ */ ((InterplayTypeId2) => {
  InterplayTypeId2[InterplayTypeId2["void"] = 0] = "void";
  InterplayTypeId2[InterplayTypeId2["bool"] = 1] = "bool";
  InterplayTypeId2[InterplayTypeId2["int"] = 2] = "int";
  InterplayTypeId2[InterplayTypeId2["uint"] = 3] = "uint";
  InterplayTypeId2[InterplayTypeId2["float"] = 4] = "float";
  InterplayTypeId2[InterplayTypeId2["bytes"] = 5] = "bytes";
  InterplayTypeId2[InterplayTypeId2["string"] = 6] = "string";
  InterplayTypeId2[InterplayTypeId2["json"] = 7] = "json";
  InterplayTypeId2[InterplayTypeId2["function"] = 8] = "function";
  InterplayTypeId2[InterplayTypeId2["array"] = 9] = "array";
  return InterplayTypeId2;
})(InterplayTypeId || {});
export {
  InterplayTypeId,
  InterplayInstance as default
};
/*!
 * @license zig-js-interplay
 *
 * Copyright (c) Daniel Oltmanns.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
//# sourceMappingURL=interplay.js.map
