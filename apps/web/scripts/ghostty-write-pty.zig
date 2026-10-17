// The import name is the ABI of the committed vendor/ghostty-write-pty.wasm,
// which only build-libghostty-wasm.sh (and its Zig 0.15.2 toolchain) can
// regenerate. Renaming it here strands the checked-in binary.
extern "env" fn t3_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;

export fn ghostty_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void {
    t3_write_pty(terminal, userdata, data, len);
}
