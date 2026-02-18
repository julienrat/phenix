#pragma once

#include <Arduino.h>
#include <FS.h>

class CsvLogger {
 public:
  CsvLogger(fs::FS &fs, const char *path, const char *header);

  bool begin(bool repair = true);
  bool appendRow(const char *col1, const char *col2, const char *col3);
  bool appendLine(const char *line);
  size_t size();

 private:
  fs::FS &fs_;
  const char *path_;
  const char *header_;

  bool ensureHeader(bool repair);
  bool rewriteWithHeader();
  bool rotateBadFile(const String &firstLine);
};
