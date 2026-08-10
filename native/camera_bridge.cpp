#include <chrono>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

static std::string json_escape(const std::string& value) {
  std::string result;
  for (char c : value) {
    switch (c) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default: result += c;
    }
  }
  return result;
}

#ifdef _WIN32
static std::wstring utf8_to_wide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), &result[0], size);
  return result;
}

static std::wstring quote_arg(const std::wstring& arg) {
  if (arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : arg) {
    if (c == L'\\') {
      ++slashes;
    } else if (c == L'"') {
      out.append(slashes * 2 + 1, L'\\');
      out += c;
      slashes = 0;
    } else {
      out.append(slashes, L'\\');
      slashes = 0;
      out += c;
    }
  }
  out.append(slashes * 2, L'\\');
  out += L'"';
  return out;
}

static int run_process(const std::string& program, const std::vector<std::string>& args, unsigned long timeout_ms) {
  std::wstring command = quote_arg(utf8_to_wide(program));
  for (const auto& arg : args) command += L" " + quote_arg(utf8_to_wide(arg));
  std::vector<wchar_t> buffer(command.begin(), command.end());
  buffer.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, buffer.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
    return -static_cast<int>(GetLastError());
  }
  const DWORD wait = WaitForSingleObject(process.hProcess, timeout_ms);
  if (wait == WAIT_TIMEOUT) {
    TerminateProcess(process.hProcess, 124);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 124;
  }
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return static_cast<int>(code);
}

static bool file_exists_nonempty(const std::string& value) {
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if (!GetFileAttributesExW(utf8_to_wide(value).c_str(), GetFileExInfoStandard, &info)) return false;
  const unsigned long long size = (static_cast<unsigned long long>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
  return (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 && size > 0;
}
#else
static int run_process(const std::string&, const std::vector<std::string>&, unsigned long) {
  return 126;
}
static bool file_exists_nonempty(const std::string& value) {
  std::ifstream file(value, std::ios::binary | std::ios::ate);
  return file && file.tellg() > 0;
}
#endif

static std::string value_after(const std::vector<std::string>& args, const std::string& name) {
  for (size_t i = 0; i + 1 < args.size(); ++i) {
    if (args[i] == name) return args[i + 1];
  }
  return {};
}

int main(int argc, char** argv) {
  std::vector<std::string> args(argv + 1, argv + argc);
  if (args.empty() || args[0] == "health") {
    std::cout << "{\"ok\":true,\"bridge\":\"photobooth-camera-bridge\",\"version\":\"0.1.0\"}\n";
    return 0;
  }
  if (args[0] != "trigger") {
    std::cerr << "{\"ok\":false,\"error\":\"unknown command\"}\n";
    return 2;
  }

  const std::string program = value_after(args, "--program");
  const std::string output = value_after(args, "--output");
  const std::string timeout_text = value_after(args, "--timeout-ms");
  const unsigned long timeout_ms = timeout_text.empty() ? 30000UL : std::stoul(timeout_text);
  std::vector<std::string> child_args;
  for (size_t i = 1; i < args.size(); ++i) {
    if (args[i] == "--arg" && i + 1 < args.size()) child_args.push_back(args[++i]);
    else if ((args[i] == "--program" || args[i] == "--output" || args[i] == "--timeout-ms") && i + 1 < args.size()) ++i;
  }
  if (program.empty() || output.empty()) {
    std::cerr << "{\"ok\":false,\"error\":\"program and output are required\"}\n";
    return 3;
  }

  const auto started = std::chrono::steady_clock::now();
  const int code = run_process(program, child_args, timeout_ms);
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  const bool exists = file_exists_nonempty(output);
  if (code != 0 || !exists) {
    std::cerr << "{\"ok\":false,\"exitCode\":" << code << ",\"outputExists\":" << (exists ? "true" : "false")
              << ",\"elapsedMs\":" << elapsed << "}\n";
    return code == 0 ? 4 : code;
  }
  std::cout << "{\"ok\":true,\"path\":\"" << json_escape(output) << "\",\"elapsedMs\":" << elapsed << "}\n";
  return 0;
}
