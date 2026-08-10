# DSLR adapter contract

`photobooth-camera-bridge.exe` does not embed Canon EDSDK because Canon distributes that SDK under a separate license. It launches a configured helper executable and waits for a captured JPEG.

The Settings screen passes every configured argument without a shell. The token `{output}` is replaced with an absolute temporary JPEG path. A helper must:

1. Connect to the selected camera.
2. Trigger capture and download the full-resolution image.
3. Write a non-empty JPEG to `{output}`.
4. Exit with code `0` only after the file is completely flushed.

Example configuration:

```text
Program: C:\CanonBridge\canon-capture.exe
Arguments:
--camera
Canon EOS R100
--output
{output}
```

The native bridge applies a timeout, checks the process exit code and verifies that the output exists before returning it to Electron.
