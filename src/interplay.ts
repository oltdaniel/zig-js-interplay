/*!
 * @license zig-js-interplay
 *
 * Copyright (c) Daniel Oltmanns.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

type InterplayTypeHalf = bigint;
type InterplayType = [InterplayTypeHalf, InterplayTypeHalf];

export default class InterplayInstance {
    /**
     * Hold the exports of the WASM instance. This is the core of this wrapper functionality.
     */
    #wasm: WebAssembly.Exports = undefined;

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
    #functionTable: {[key: number]: Function} = {};

    /**
     * There will be functions assigned by name from the WASM exports and made accessible directly.
     */
    [key: string]: Function;

    /**
     * Initialize a new Wrapper instance from an url which is loaded in async via fetch.
     * 
     * @param wasmUrl URL to given wasm file that should be loaded
     * @returns new instance of the ZigWASMWrapper for this wasm file
     */
    static async initializeFromUrl(wasmUrl: URL): Promise<InterplayInstance> {
        const rawWasm = await fetch(wasmUrl).then(resp => resp.arrayBuffer());

        return this.initialize(rawWasm);
    }

    /**
     * Initialize a new Wrapper directly from the raw WASM bytes.
     * 
     * @param rawModule raw bytes of the wasm module to initialize
     * @returns new instance of the ZigWASMWrapper for this wasm file
     */
    static async initialize(rawModule: BufferSource): Promise<InterplayInstance> {
        const inst = new this();

        const obj = await WebAssembly.instantiate(rawModule, {
            js: {
                log: (arg: InterplayTypeHalf, arg2: InterplayTypeHalf) => {
                    let message = inst.#decodeInterplayType([arg, arg2]).value;
                    console.log(message);
                },
                call: (func: InterplayTypeHalf, func2: InterplayTypeHalf, args: InterplayTypeHalf, args2: InterplayTypeHalf) => {
                    let f = inst.#decodeInterplayType([func, func2]).value;

                    if(Object.getPrototypeOf(f).origin != 1) {
                        throw new Error('Function to be executed in JS expected to be of JS origin.');
                    }

                    let a = inst.#decodeInterplayType([args, args2]).value;

                    return inst.#encodeInterplayType(f(...a));
                }
            },
        })

        inst.#loadWasmObj(obj);

        return inst;
    }

    constructor() {}

    /**
     * This function does some initialization for a loaded WASM module and raises the WASM exports to functions directly
     * accessible from this very class instance via the interplay wrapper.
     * 
     * @param obj the instantiated WASM source for which this class has been created
     */
    #loadWasmObj(obj: WebAssembly.WebAssemblyInstantiatedSource) {
        this.#wasm = obj.instance.exports;

        // Expose the exported custom functions that are not implementation relevant
        for (let name of Object.keys(this.#wasm).filter(n => !['malloc', 'free', 'memory', 'call'].includes(n))) {
            // Make sure we only wrap exported functions
            if(typeof this.#wasm[name] !== 'function') {
                // TODO: Parse constants as well and expose them via getter methods.
                console.warn('We currently only make exported functions accessible through the Interplay Wrapper.')
                continue;
            }

            this[name] = this.#wrappedCallHandler(name)
        }
    }

    /**
     * This not only returns a wrapped function handler, it also checks of the actual export is even a function that we could
     * call. This should only be called if the caller is sure, the named export is actually a function.
     * 
     * @param funcName name of the exported wasm function to wrap
     * @returns handler function for a wrapped call to the named function
     */
    #wrappedCallHandler(funcName: string): Function {
        const wasmFunc = this.#wasm[funcName];

        // Verify the 
        if(typeof wasmFunc !== 'function') throw new Error('WASM export is not callable!');

        return (...args): any => {
            return this.#wrappedCall(wasmFunc, ...args)
        }
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
    #wrappedCall(func: Function, ...args) {
        // Encode the arguments to interplay types and flatten the array.
        // The exported wasm functions only accept direct arguments, no arrays or other types.
        const wasmArgs = args.map(a => this.#encodeInterplayType(a)).flat()

        const r = func(...wasmArgs);

        // There is no need for the wasm function to return something. So we only decode interplay types if we received
        // an actual value as a return.
        return r ? this.#decodeInterplayType(r).value : undefined;
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
    #extractBitSections(value: bigint, sections: Array<[string, number]>)  {
        const r: {[key: string]: bigint} = {};

        let bits = value;
        for(const section of sections) {
            r[section[0]] = BigInt.asUintN(section[1], bits);
            bits >>= BigInt(section[1]);
        }

        return r;
    }

    // TODO: Implement this to avoid weird lines of code for encoding
    #packBitSections(sections: Array<[string, number, bigint]>): bigint { return 0n }

    /**
     * Detect the correct InterplayTypeId for any JS value. If the type is not supported, we throw an error.
     * 
     * @param value the value of which the InterplayTypeId should be detected from
     * @returns the detected InterplayTypeId
     */
    #mapValueToInterplayTypeId(value: any): InterplayTypeId {
        switch (typeof value) {
            case 'string':
                return InterplayTypeId.string;
            case 'number':
                return ((value % 1) === 0) ? (value < 0) ? InterplayTypeId.int : InterplayTypeId.uint : InterplayTypeId.float;
            case 'bigint':
                return (value < 0n) ? InterplayTypeId.int : InterplayTypeId.uint;
            case 'boolean':
                return InterplayTypeId.bool;
            case 'symbol':
                throw new Error(`type '${typeof value}' (value '${String(value)}') not implemented`)
            case 'undefined':
                return InterplayTypeId.void;
            case 'object': {
                if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
                    return InterplayTypeId.bytes;
                }
                if(Array.isArray(value)) {
                    return InterplayTypeId.array;
                }
                return InterplayTypeId.json;
            }
            case 'function':
                return InterplayTypeId.function;
            default:
                // NOTE: This is just in case, this should be unreachable
                throw new Error(`type '${typeof value}' not implemented`)
        }
    }

    /**
     * Decode a given Interplay Type to its JavaScript value. Any allocations done to the interplay type can be freed
     * after this call, as the return value does not depend on the origin value.
     * 
     * @param value interplay type to decode
     * @returns decoded interplay type as javascript value
     */
    #decodeInterplayType(value: InterplayType): any {
        // Merge the interplay type to a single u128 value
        const ipl = BigInt.asUintN(64, value[0]) | (BigInt.asUintN(64, value[1]) << 64n);

        // Extract type and value sections
        const { type, details } = this.#extractBitSections(ipl, [
            ['type', 4],
            ['details', 124]
        ]);

        switch (Number(type)) {
            case InterplayTypeId.void:
                return { type };
            case InterplayTypeId.bool:
                return { type, value: ((details & 0x1n) == 1n) ? true : false };
            case InterplayTypeId.int:
                return { type, value: BigInt.asIntN(124, details) };
            case InterplayTypeId.uint:
                return { type, value: BigInt.asUintN(124, details) };
            case InterplayTypeId.float: {
                // We only care about the first 64bit for the float
                const rawFloatValue = BigInt.asUintN(64, details);

                // Move the value into a correct representation
                const tempBuf = new ArrayBuffer(8);
                const tempBufView = new DataView(tempBuf);
                tempBufView.setBigUint64(0, rawFloatValue);

                // Return correct float value
                return { type, value: tempBufView.getFloat64(0) };
            }
            case InterplayTypeId.bytes: {
                const buf = this.#decodeBytesLikeType(details);

                // NOTE: It is important to slice as the buf is only pointing to the raw WASM memory section
                return { type, value: buf.slice() };
            }
            case InterplayTypeId.string: {
                const buf = this.#decodeBytesLikeType(details);
                const str = this.#textDecoder.decode(buf);

                return { type, value: str };
            }
            case InterplayTypeId.json: {
                const buf = this.#decodeBytesLikeType(details);
                const str = this.#textDecoder.decode(buf);
                const json = JSON.parse(str)

                return { type, value: json };
            }
            case InterplayTypeId.function: {
                // Create a function that behaves just like a JavaScript function
                const f = function (...args) {
                    // If the function is of JavaScript origin, we can just call it straight from the function table
                    if(this.prototype.origin == 1) {
                        return this.prototype.inst.#functionTable[this.prototype.ptr](args)
                    } else {
                        // Else we do a wrapped call to the referenced zig function
                        return this.prototype.inst.#wrappedCall(this.prototype.inst.#wasm.call, this, args);
                    }
                }
                // Extract pointer and origin of the function
                const { ptr, origin } = this.#extractBitSections(details, [
                    ['ptr', 32],
                    ['origin', 1],
                ])

                // Store function attributes in prototype so we can recoginize it again
                f.prototype.ptr = ptr;
                f.prototype.origin = origin;
                f.prototype.inst = this;

                // Bind it to itself so we can reference this within the function
                const boundF = f.bind(f);
                // Copy over the prototype to the bound function
                Object.setPrototypeOf(boundF, f.prototype);

                return { type, value: boundF };
            }
            case InterplayTypeId.array: {
                // Extract pointer and number of items of the array
                const { ptr, len } = this.#extractBitSections(details, [
                    ['ptr', 32],
                    ['len', 32],
                ])

                // View as array of u64, the length is twice as long as the number of items because len * 128bit = len * 2 * 64bit
                const tempBuf = new BigUint64Array((this.#wasm.memory as unknown as Uint8Array).buffer, Number(ptr), Number(len * 2n));

                const decodedArray = [];
                for(let i = 0; i < len; i++) {
                    const iplVariable = Array.from(tempBuf.subarray(i * 2, (i + 1) * 2)) as InterplayType;
                    const variable = this.#decodeInterplayType(iplVariable);

                    decodedArray.push(variable.value);
                }

                return { type, value: decodedArray };
            }
            default:
                throw new Error(`Interplay type ${type} is not supported for decoding.`)
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
    #encodeInterplayType(value: any): InterplayType {
        // Detect interplay type for the value so we can continue to encode it
        const iplType = this.#mapValueToInterplayTypeId(value);
        // Temporary placeholder for the value within the interplay type
        let iplValue: bigint = 0n;

        switch (iplType) {
            case InterplayTypeId.void:
                break;
            case InterplayTypeId.bool:
            case InterplayTypeId.int:
            case InterplayTypeId.uint:
                // No special encoding required here, but cutting it down to 124bit
                iplValue = BigInt.asUintN(124, BigInt(value));
                break;
            case InterplayTypeId.float: {
                // Create a temporary buffer of size 64bit
                const tempBuf = new ArrayBuffer(8);
                const tempBufView = new DataView(tempBuf);
                // Cut down the float to 64bit to match zig side
                tempBufView.setFloat64(0, value);
                // Extract set 64bit float as 64bit unsigned integer
                iplValue = tempBufView.getBigUint64(0);
                break; 
            }
            case InterplayTypeId.bytes: {
                // We accept Uint8array and ArrayBuffer, so we need to find a common here
                const buf = (value instanceof Uint8Array) ? value : new Uint8Array(value);
                iplValue = this.#encodeBytesLikeType(buf);
                break;
            }
            case InterplayTypeId.string: {
                // Encode the string to raw bytes that we can actually allocate and copy
                const buf = this.#textEncoder.encode(value);
                iplValue = this.#encodeBytesLikeType(buf);
                break;
            }
            case InterplayTypeId.json: {
                // Encode the string to raw bytes that we can actually allocate and copy
                const buf = this.#textEncoder.encode(JSON.stringify(value));
                iplValue = this.#encodeBytesLikeType(buf);
                break;
            }
            case InterplayTypeId.function: {
                // Check if we have a Zig function given to us. If so, we can just directly encode its details.
                if(value.prototype && Object.hasOwn(value.prototype, 'origin') && Object.hasOwn(value.prototype, 'ptr') && value.prototype.origin == 0) {
                    // Encode the pointer and origin of the zig function
                    iplValue = (BigInt.asUintN(1, value.prototype.origin) << 32n) | BigInt.asUintN(32, value.prototype.ptr);
                } else {
                    // Get the next key for the new JS function
                    const key = Object.keys(this.#functionTable).length;
                    // Store the js function in our internal function table
                    this.#functionTable[key] = (args) => {
                        return value(...args)
                    };
                    // Encode the key as the pointer and set JS as the function origin
                    iplValue = (BigInt.asUintN(1, 1n) << 32n) | BigInt.asUintN(32, BigInt(key));
                }
                break;
            }
            case InterplayTypeId.array: {
                // Check if an empty array is given to us. If so, we can just leave all bits at zero.
                if(value.length == 0) break;
                // Calculate the length of the space we need to allocate (number of items * 128bit = number of items * 16bytes)
                const bufLen = value.length * 16;
                const ptr = (this.#wasm.malloc as Function)(bufLen);
                // We can view this space as an array of InterplayTypesHalf
                const tempBuf = new BigUint64Array((this.#wasm.memory as unknown as Uint8Array).buffer, ptr, bufLen);
                // Encode each value of the given array and store its InterplayType in the allocated buffer
                for(let i = 0; i < value.length; i++) {
                    const encodedEl = this.#encodeInterplayType(value[i]);
                    
                    tempBuf[i * 2] = encodedEl[0];
                    tempBuf[(i * 2) + 1] = encodedEl[1];
                }
                // Encode the pointer and number of items
                iplValue = (BigInt.asUintN(32, BigInt(value.length)) << 32n) | BigInt.asUintN(32, BigInt(ptr));
                break;
            }
            default:
                throw new Error(`Interplay type ${iplType} is not supported for encoding.`)
        }

        // Merge type and value to 128bit bigint
        let fullInfo = BigInt.asUintN(4, BigInt(iplType)) | (BigInt.asUintN(124, BigInt(iplValue)) << 4n);
        // Split 128bit bigint to two 64bit chunks
        let r: InterplayType = [BigInt.asUintN(64, fullInfo), BigInt.asUintN(64, fullInfo >> 64n)]

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
    #decodeBytesLikeType(value: bigint) {
        // Extract pointer and length from the details
        const { ptr, len } = this.#extractBitSections(value, [
            ['ptr', 32],
            ['len', 32],
        ]);
        // Return a specific uint8array for that memory region
        return new Uint8Array((this.#wasm.memory as unknown as Uint8Array).buffer, Number(ptr), Number(len));
    }

    /**
     * This is a shortcut to easily copy bytes like interplay types to memory. This copies the given buffer and the given buffer
     * is free to be cleared/freed or used otherwise after this call.
     * 
     * @param buf to copy as bytes like interplay type to wasm memory
     * @returns encoded interplay type for this buffer
     */
    #encodeBytesLikeType(buf: Uint8Array): bigint {
        const len = buf.byteLength;
        // Allocate space in the wasm memory where we can copy these bytes
        const ptr = (this.#wasm.malloc as Function)(len);
        // Copy the buffer data over to the wasm memory
        new Uint8Array((this.#wasm.memory as unknown as Uint8Array).buffer, ptr, len).set(buf);
        // Encode the pointer and length
        return (BigInt.asUintN(32, BigInt(len)) << 32n) | BigInt.asUintN(32, BigInt(ptr));
    }
}

/**
 * This is the equivalent to the InterplayTypeId in the interplay.zig file.
 */
export enum InterplayTypeId {
    void = 0,
    bool = 1,
    int = 2,
    uint = 3,
    float = 4,
    bytes = 5,
    string = 6,
    json = 7,
    function = 8,
    array = 9
};