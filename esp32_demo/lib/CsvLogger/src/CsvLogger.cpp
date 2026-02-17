#include "CsvLogger.h"
#include <ctype.h>

CsvLogger::CsvLogger(fs::FS &fs, const char *path, const char *header)
    : fs_(fs), path_(path), header_(header) {}

bool CsvLogger::begin(bool repair) {
  return ensureHeader(repair);
}

size_t CsvLogger::size() {
  if (!fs_.exists(path_)) return 0;
  File file = fs_.open(path_, "r");
  if (!file) return 0;
  size_t out = file.size();
  file.close();
  return out;
}

bool CsvLogger::appendRow(const char *col1, const char *col2, const char *col3) {
  if (!ensureHeader(true)) return false;
  File file = fs_.open(path_, "a");
  if (!file) return false;
  file.print(col1 ? col1 : "");
  file.print(',');
  file.print(col2 ? col2 : "");
  file.print(',');
  file.print(col3 ? col3 : "");
  file.print('\n');
  file.close();
  return true;
}

bool CsvLogger::ensureHeader(bool repair) {
  if (!fs_.exists(path_)) {
    File file = fs_.open(path_, "w");
    if (!file) return false;
    file.print(header_);
    file.print('\n');
    file.close();
    return true;
  }

  File file = fs_.open(path_, "r");
  if (!file) return false;
  String firstLine = file.readStringUntil('\n');
  file.close();
  firstLine.trim();

  if (firstLine.length() == 0) {
    return rewriteWithHeader();
  }
  if (firstLine == header_) {
    return true;
  }

  if (!repair) return true;

  const bool looksLikeData = isdigit((unsigned char)firstLine[0]);
  if (!looksLikeData) {
    return rotateBadFile(firstLine);
  }
  return rewriteWithHeader();
}

bool CsvLogger::rewriteWithHeader() {
  const char *tmpPath = "/log_tmp.csv";
  if (fs_.exists(tmpPath)) fs_.remove(tmpPath);
  File src = fs_.open(path_, "r");
  File dst = fs_.open(tmpPath, "w");
  if (!src || !dst) {
    if (src) src.close();
    if (dst) dst.close();
    return false;
  }
  dst.print(header_);
  dst.print('\n');
  while (src.available()) {
    dst.write((uint8_t)src.read());
  }
  src.close();
  dst.close();
  fs_.remove(path_);
  fs_.rename(tmpPath, path_);
  return true;
}

bool CsvLogger::rotateBadFile(const String &firstLine) {
  String badPath = String(path_);
  badPath.replace(".csv", "_bad.csv");
  if (fs_.exists(badPath)) fs_.remove(badPath);
  fs_.rename(path_, badPath);
  File file = fs_.open(path_, "w");
  if (!file) return false;
  file.print(header_);
  file.print('\n');
  file.close();
  (void)firstLine;
  return true;
}
