// The host provides this import when it instantiates the trampoline, so the
// name is part of the vendored ghostty-write-pty.wasm ABI.
extern "env" fn t2_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;

export fn ghostty_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void {
    t2_write_pty(terminal, userdata, data, len);
}
