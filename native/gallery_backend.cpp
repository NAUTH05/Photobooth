#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

using json = nlohmann::json;

namespace {

struct Options {
  std::string host = "0.0.0.0";
  int port = 3847;
  std::string queue_path;
  std::string static_root;
};

std::string value_after(int argc, char** argv, const std::string& name) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (argv[index] == name) return argv[index + 1];
  }
  return {};
}

Options parse_options(int argc, char** argv) {
  Options options;
  const auto host = value_after(argc, argv, "--host");
  const auto port = value_after(argc, argv, "--port");
  options.queue_path = value_after(argc, argv, "--queue");
  options.static_root = value_after(argc, argv, "--static");
  if (!host.empty()) options.host = host;
  if (!port.empty()) options.port = std::max(0, std::min(65535, std::atoi(port.c_str())));
  if (options.queue_path.empty() || options.static_root.empty()) {
    throw std::runtime_error("--queue and --static are required");
  }
  return options;
}

std::string join_path(const std::string& root, const std::string& name) {
  if (root.empty()) return name;
  const char last = root[root.size() - 1];
  if (last == '/' || last == '\\') return root + name;
#ifdef _WIN32
  return root + "\\" + name;
#else
  return root + "/" + name;
#endif
}

bool read_file(const std::string& path, std::string& output) {
  std::ifstream input(path.c_str(), std::ios::binary);
  if (!input) return false;
  std::ostringstream stream;
  stream << input.rdbuf();
  output = stream.str();
  return input.good() || input.eof();
}

bool load_queue(const Options& options, json& queue) {
  std::string text;
  for (int attempt = 0; attempt < 3; ++attempt) {
    if (read_file(options.queue_path, text)) {
      try {
        queue = json::parse(text);
        return queue.is_object() && queue.contains("sessions") && queue["sessions"].is_object();
      } catch (const json::exception&) {}
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
  }
  return false;
}

std::string now_iso_utc() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t time = std::chrono::system_clock::to_time_t(now);
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &time);
#else
  gmtime_r(&time, &utc);
#endif
  std::ostringstream result;
  result << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S");
  return result.str();
}

bool expired(const json& session) {
  if (!session.contains("expiresAt") || !session["expiresAt"].is_string()) return false;
  const auto value = session["expiresAt"].get<std::string>();
  return value.size() >= 19 && value.substr(0, 19) <= now_iso_utc();
}

bool constant_time_equal(const std::string& left, const std::string& right) {
  const std::size_t count = std::max(left.size(), right.size());
  unsigned char difference = static_cast<unsigned char>(left.size() ^ right.size());
  for (std::size_t index = 0; index < count; ++index) {
    const unsigned char a = index < left.size() ? static_cast<unsigned char>(left[index]) : 0;
    const unsigned char b = index < right.size() ? static_cast<unsigned char>(right[index]) : 0;
    difference |= static_cast<unsigned char>(a ^ b);
  }
  return difference == 0;
}

bool token_valid(const json& session, const httplib::Request& request) {
  if (!request.has_param("t") || !session.contains("galleryToken") || !session["galleryToken"].is_string()) return false;
  const auto expected = session["galleryToken"].get<std::string>();
  return expected.size() >= 22 && constant_time_equal(request.get_param_value("t"), expected);
}

enum class Lookup { ok, queue_unavailable, not_found, denied, expired };

Lookup find_session(const Options& options, const httplib::Request& request,
                    const std::string& session_id, json& session) {
  json queue;
  if (!load_queue(options, queue)) return Lookup::queue_unavailable;
  const auto& sessions = queue["sessions"];
  const auto iterator = sessions.find(session_id);
  if (iterator == sessions.end() || !iterator->is_object()) return Lookup::not_found;
  session = *iterator;
  if (!token_valid(session, request)) return Lookup::denied;
  if (expired(session)) return Lookup::expired;
  return Lookup::ok;
}

void secure_headers(httplib::Response& response) {
  response.set_header("Cache-Control", "no-store");
  response.set_header("X-Content-Type-Options", "nosniff");
  response.set_header("Referrer-Policy", "no-referrer");
  response.set_header("X-Frame-Options", "DENY");
}

void json_response(httplib::Response& response, int status, const json& body) {
  response.status = status;
  response.set_content(body.dump(), "application/json; charset=utf-8");
  secure_headers(response);
}

void text_response(httplib::Response& response, int status, const std::string& message) {
  response.status = status;
  response.set_content(message, "text/plain; charset=utf-8");
  secure_headers(response);
}

bool serve_static(const Options& options, const std::string& name,
                  const char* content_type, httplib::Response& response) {
  std::string content;
  if (!read_file(join_path(options.static_root, name), content)) {
    text_response(response, 503, "Gallery frontend chưa được cài đặt.");
    return false;
  }
  response.set_content(content, content_type);
  secure_headers(response);
  return true;
}

std::string lower_extension(const std::string& filename) {
  const auto position = filename.find_last_of('.');
  if (position == std::string::npos) return {};
  std::string extension = filename.substr(position);
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
  return extension;
}

std::string mime_type(const std::string& filename) {
  const auto extension = lower_extension(filename);
  if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
  if (extension == ".png") return "image/png";
  if (extension == ".webp") return "image/webp";
  return {};
}

bool valid_image_signature(const std::string& path, const std::string& mime) {
  std::ifstream input(path.c_str(), std::ios::binary);
  unsigned char bytes[12]{};
  input.read(reinterpret_cast<char*>(bytes), sizeof(bytes));
  const auto count = input.gcount();
  if (mime == "image/jpeg") return count >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff;
  if (mime == "image/png") {
    const unsigned char signature[] = {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
    return count >= 8 && std::equal(signature, signature + 8, bytes);
  }
  if (mime == "image/webp") {
    return count >= 12 && std::equal(bytes, bytes + 4, reinterpret_cast<const unsigned char*>("RIFF"))
      && std::equal(bytes + 8, bytes + 12, reinterpret_cast<const unsigned char*>("WEBP"));
  }
  return false;
}

std::string safe_filename(std::string value) {
  for (auto& character : value) {
    if (character == '"' || character == '\r' || character == '\n' || character == '\\' || character == '/') character = '_';
  }
  return value.empty() ? "photo.jpg" : value;
}

bool safe_drive_id(const std::string& value) {
  if (value.empty() || value.size() > 200) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return std::isalnum(character) || character == '-' || character == '_';
  });
}

bool gallery_item(const json& item) {
  if (!item.is_object() || !item.contains("kind") || !item["kind"].is_string()) return false;
  const auto kind = item["kind"].get<std::string>();
  return kind.find("photo") == 0 || kind.find("dslr") == 0;
}

json public_session(const json& session) {
  json result = {
    {"id", session.value("id", "")},
    {"createdAt", session.value("createdAt", "")},
    {"expiresAt", session.value("expiresAt", "")},
    {"status", session.value("status", "pending")},
    {"items", json::array()}
  };
  if (!session.contains("items") || !session["items"].is_array()) return result;
  for (const auto& item : session["items"]) {
    if (!gallery_item(item) || !item.contains("id") || !item["id"].is_string()) continue;
    const auto id = item["id"].get<std::string>();
    const auto kind = item.value("kind", "photo");
    result["items"].push_back({
      {"id", id},
      {"kind", kind},
      {"filename", item.value("filename", "photo.jpg")},
      {"size", item.value("size", 0)},
      {"createdAt", item.value("createdAt", "")},
      {"label", kind == "photo-strip" ? "Ảnh ghép 4×6" : "Ảnh gốc"},
      {"mediaUrl", "/media/" + session.value("id", "") + "/" + id},
      {"downloadUrl", "/media/" + session.value("id", "") + "/" + id + "?download=1"}
    });
  }
  return result;
}

const json* find_item(const json& session, const std::string& item_id) {
  if (!session.contains("items") || !session["items"].is_array()) return nullptr;
  for (const auto& item : session["items"]) {
    if (item.is_object() && item.value("id", "") == item_id && gallery_item(item)) return &item;
  }
  return nullptr;
}

void lookup_error(Lookup lookup, httplib::Response& response, bool html = false) {
  if (lookup == Lookup::queue_unavailable) return text_response(response, 503, "Dữ liệu gallery đang được cập nhật. Vui lòng thử lại.");
  if (lookup == Lookup::expired) {
    if (html) {
      response.status = 410;
      response.set_content("<!doctype html><html lang=\"vi\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Gallery hết hạn</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4efe9;color:#1f2522;font:16px system-ui}.card{width:min(420px,86vw);padding:42px;background:#fff;border:1px solid #ded7ce;border-radius:28px;text-align:center;box-shadow:0 24px 80px #33281d18}b{font-size:46px}h1{font-family:Georgia,serif;font-size:35px}p{color:#6b706c;line-height:1.7}</style><main class=\"card\"><b>⌛</b><h1>Bộ ảnh đã hết hạn</h1><p>Liên kết nhận ảnh không còn hiệu lực. Hãy liên hệ đơn vị photobooth nếu bạn cần hỗ trợ.</p></main></html>", "text/html; charset=utf-8");
      secure_headers(response);
      return;
    }
    return json_response(response, 410, {{"error", "Bộ ảnh đã hết hạn"}});
  }
  text_response(response, 404, "Không tìm thấy bộ ảnh.");
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  try {
    options = parse_options(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 2;
  }

  httplib::Server server;
  server.set_read_timeout(10, 0);
  server.set_write_timeout(30, 0);
  server.set_idle_interval(0, 100000);

  server.Get("/health", [](const httplib::Request&, httplib::Response& response) {
    json_response(response, 200, {{"ok", true}, {"backend", "cpp"}, {"version", "1.0.0"}});
  });
  server.Get("/api/health", [](const httplib::Request&, httplib::Response& response) {
    json_response(response, 200, {{"status", "ok"}, {"backend", "cpp"}, {"version", "1.0.0"}});
  });
  server.Get("/assets/gallery.css", [&](const httplib::Request&, httplib::Response& response) {
    serve_static(options, "gallery.css", "text/css; charset=utf-8", response);
  });
  server.Get("/assets/gallery.js", [&](const httplib::Request&, httplib::Response& response) {
    serve_static(options, "gallery.js", "application/javascript; charset=utf-8", response);
  });

  server.Get(R"(/s/([A-Za-z0-9_-]+))", [&](const httplib::Request& request, httplib::Response& response) {
    json session;
    const auto lookup = find_session(options, request, request.matches[1], session);
    if (lookup != Lookup::ok) return lookup_error(lookup, response, true);
    if (!serve_static(options, "index.html", "text/html; charset=utf-8", response)) return;
    response.set_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  });

  server.Get(R"(/api/public/sessions/([A-Za-z0-9_-]+))", [&](const httplib::Request& request, httplib::Response& response) {
    json session;
    const auto lookup = find_session(options, request, request.matches[1], session);
    if (lookup != Lookup::ok) return lookup_error(lookup, response);
    json_response(response, 200, public_session(session));
  });

  server.Get(R"(/media/([A-Za-z0-9_-]+)/([A-Fa-f0-9-]+))", [&](const httplib::Request& request, httplib::Response& response) {
    json session;
    const auto lookup = find_session(options, request, request.matches[1], session);
    if (lookup != Lookup::ok) return lookup_error(lookup, response);
    const auto* item = find_item(session, request.matches[2]);
    if (!item) return text_response(response, 404, "Không tìm thấy ảnh.");
    const auto filename = item->value("filename", "photo.jpg");
    const auto mime = mime_type(filename);
    if (mime.empty()) return text_response(response, 415, "Định dạng ảnh không được hỗ trợ.");
    const bool download = request.has_param("download") && request.get_param_value("download") == "1";
    if (!item->contains("deletedAt") && item->contains("path") && (*item)["path"].is_string()) {
      const auto path = (*item)["path"].get<std::string>();
      if (valid_image_signature(path, mime)) {
        response.set_header("Content-Disposition", std::string(download ? "attachment" : "inline") + "; filename=\"" + safe_filename(filename) + "\"");
        response.set_header("Cache-Control", "private, max-age=300");
        response.set_header("X-Content-Type-Options", "nosniff");
        response.set_file_content(path, mime);
        return;
      }
    }
    if (item->contains("driveFileId") && (*item)["driveFileId"].is_string()) {
      const auto drive_id = (*item)["driveFileId"].get<std::string>();
      if (safe_drive_id(drive_id)) {
        response.status = 302;
        response.set_header("Location", "https://drive.google.com/uc?export=" + std::string(download ? "download" : "view") + "&id=" + drive_id);
        return;
      }
    }
    text_response(response, 410, "Ảnh đang được đồng bộ. Vui lòng thử lại sau.");
  });

  server.set_error_handler([](const httplib::Request&, httplib::Response& response) {
    if (response.status == 404) text_response(response, 404, "Not found");
  });

  int port = -1;
  if (options.port == 0) {
    port = server.bind_to_any_port(options.host);
  } else if (server.bind_to_port(options.host, options.port)) {
    port = options.port;
  } else {
    port = server.bind_to_any_port(options.host);
  }
  if (port < 0) {
    std::cerr << "cannot bind gallery backend" << '\n';
    return 3;
  }
  std::cout << json({{"ready", true}, {"port", port}, {"backend", "cpp"}}).dump() << std::endl;
  return server.listen_after_bind() ? 0 : 4;
}
