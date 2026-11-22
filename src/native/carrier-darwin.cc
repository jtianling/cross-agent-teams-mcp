#include <node_api.h>
#include <libproc.h>
#include <mach/vm_prot.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <set>
#include <stdexcept>
#include <string>
#include <system_error>
#include <vector>

namespace {
void check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("Invalid native probe input");
}

std::string text(napi_env env, napi_value value) {
  size_t length;
  check(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  std::vector<char> bytes(length + 1);
  check(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length));
  return {bytes.data(), length};
}

void failed(const char* operation) {
  throw std::system_error(errno, std::generic_category(), operation);
}

bool info(int pid, proc_bsdinfo& result) {
  int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &result, sizeof(result));
  if (!n && errno == ESRCH) return false;
  if (!n) failed("proc_pidinfo");
  if (n != sizeof(result) || result.pbi_pid != static_cast<unsigned>(pid))
    throw std::runtime_error("Incomplete BSD process information");
  return true;
}

std::vector<int> tty_pids(dev_t dev) {
  for (size_t capacity = 64; capacity <= 65536; capacity *= 2) {
    std::vector<int> pids(capacity);
    errno = 0;
    int size = proc_listpids(PROC_TTY_ONLY, dev, pids.data(), capacity * sizeof(int));
    if (size < 0 || (!size && errno)) failed("proc_listpids");
    if (size % sizeof(int)) throw std::runtime_error("Invalid tty PID list");
    if (static_cast<size_t>(size) >= (capacity - 1) * sizeof(int)) continue;
    pids.resize(size / sizeof(int));
    return pids;
  }
  throw std::runtime_error("TTY PID list exceeds limit");
}

bool same_birth(const proc_bsdinfo& a, const proc_bsdinfo& b) {
  return a.pbi_start_tvsec == b.pbi_start_tvsec &&
    a.pbi_start_tvusec == b.pbi_start_tvusec;
}

std::string basename_of(const std::string& path) {
  return path.substr(path.rfind('/') + 1);
}

std::string executable_name(const proc_bsdinfo& before) {
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(before.pbi_pid, path, sizeof(path)) > 0) return basename_of(path);
  if (errno == ESRCH) return {};
  if (errno != ENOENT) failed("proc_pidpath");

  // An upgrade can unlink a live executable. Require the kernel's text
  // mapping and BSD process name to agree before inspecting its argv.
  proc_regionwithpathinfo region{};
  int n = proc_pidinfo(before.pbi_pid, PROC_PIDREGIONPATHINFO, 0,
    &region, sizeof(region));
  if (!n && (errno == ESRCH || errno == EINVAL || errno == ENOENT)) return {};
  if (!n) failed("proc_pidinfo text mapping");
  if (n != sizeof(region)) throw std::runtime_error("Incomplete text mapping");
  if (!(region.prp_prinfo.pri_protection & VM_PROT_EXECUTE) ||
      region.prp_prinfo.pri_offset != 0) return {};
  std::string mapped = basename_of(region.prp_vip.vip_path);
  return mapped == before.pbi_comm ? mapped : "";
}

bool matches(const proc_bsdinfo& before, const std::string& launch,
    std::vector<char>& bytes) {
  int pid = before.pbi_pid;
  const std::string executable = executable_name(before);
  const bool node = executable == "node";
  if (!node && executable != "codex" && executable != "codex-aarch64-a")
    return false;
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = bytes.size();
  if (sysctl(mib, 3, bytes.data(), &size, nullptr, 0) < 0) {
    if (errno == ESRCH) return false;
    if (errno == EINVAL) {
      proc_bsdinfo current{};
      if (!info(pid, current) || !same_birth(before, current)) return false;
      errno = EINVAL;
    }
    failed("KERN_PROCARGS2");
  }
  int argc;
  if (size <= sizeof(argc)) throw std::runtime_error("Incomplete process argv");
  memcpy(&argc, bytes.data(), sizeof(argc));
  char* end = bytes.data() + size;
  char* p = std::find(bytes.data() + sizeof(argc), end, '\0');
  while (p < end && !*p) ++p;
  bool codex = false, remote = false, marker = false;
  bool option_value = false, config_value = false;
  for (int i = 0; i < argc; ++i) {
    auto next = std::find(p, end, '\0');
    if (next == end) throw std::runtime_error("Truncated process argv");
    std::string arg(p, next);
    p = next + 1;
    if (i <= (node ? 1 : 0)) {
      auto base = arg.substr(arg.rfind('/') + 1);
      if (i == (node ? 1 : 0))
        codex = base == "codex" || base == "codex-aarch64-a";
      continue;
    }
    if (config_value) {
      if (arg.rfind("xats.agent_id=", 0) == 0) marker = arg == launch;
      config_value = false;
      continue;
    }
    if (option_value) { option_value = false; continue; }
    if (arg == "--") break;
    if (arg == "app-server") return false;
    if (arg.rfind("--config=xats.agent_id=", 0) == 0)
      marker = arg == "--config=" + launch;
    if (arg.rfind("-cxats.agent_id=", 0) == 0) marker = arg == "-c" + launch;
    config_value = arg == "-c" || arg == "--config";
    remote |= arg == "--remote" || (arg.rfind("--remote=", 0) == 0 && arg.size() > 9);
    option_value = arg == "-C" || arg == "--cd" || arg == "--add-dir" ||
      arg == "-m" || arg == "--model" || arg == "-p" || arg == "--profile" ||
      arg == "--remote" || arg == "-i" || arg == "--image";
  }
  return codex && remote && marker;
}

bool foreground(const proc_bsdinfo& p, dev_t dev) {
  return p.e_tdev == static_cast<unsigned>(dev) && p.pbi_status != SZOMB
    && p.pbi_status != SSTOP && p.pbi_pgid > 0 && p.pbi_pgid == p.e_tpgid;
}

std::string inspect(const std::string& tty, int expected, const std::string& launch) {
  struct stat st;
  if (stat(("/dev/" + tty).c_str(), &st) < 0) {
    if (errno == ENOENT) return "stale";
    failed("stat tty");
  }
  if (!S_ISCHR(st.st_mode)) return "stale";
  long argmax = sysconf(_SC_ARG_MAX);
  if (argmax <= 0) throw std::runtime_error("Invalid argument buffer capacity");
  std::vector<char> args(argmax);
  std::set<int> groups;
  unsigned matched = 0;
  proc_bsdinfo selected{};
  for (int pid : tty_pids(st.st_rdev)) {
    proc_bsdinfo before{}, after{};
    if (!info(pid, before) || !foreground(before, st.st_rdev)) continue;
    if (!matches(before, launch, args)) continue;
    if (!info(pid, after) || !foreground(after, st.st_rdev)
        || before.pbi_pgid != after.pbi_pgid
        || !same_birth(before, after)) return "stale";
    groups.insert(after.pbi_pgid);
    ++matched;
    if (pid == expected) selected = after;
  }
  if (groups.size() > 1) return "ambiguous";
  if (!selected.pbi_pid || (matched > 1 && selected.pbi_pgid != selected.pbi_pid))
    return "stale";
  return "ok";
}

napi_value verify(napi_env env, napi_callback_info call) {
  try {
    size_t count = 3;
    napi_value argv[3], result;
    check(napi_get_cb_info(env, call, &count, argv, nullptr, nullptr));
    if (count != 3) throw std::runtime_error("Expected tty, pid and launch");
    auto tty = text(env, argv[0]);
    if (tty.empty() || tty.find_first_not_of(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != tty.npos)
      throw std::runtime_error("Invalid tty name");
    int pid;
    check(napi_get_value_int32(env, argv[1], &pid));
    auto status = inspect(tty, pid, "xats.agent_id=\"" + text(env, argv[2]) + "\"");
    check(napi_create_string_utf8(env, status.data(), status.size(), &result));
    return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}
}

NAPI_MODULE_INIT() {
  napi_property_descriptor property = {"verify", nullptr, verify, nullptr,
    nullptr, nullptr, napi_default, nullptr};
  if (napi_define_properties(env, exports, 1, &property) != napi_ok) return nullptr;
  return exports;
}
