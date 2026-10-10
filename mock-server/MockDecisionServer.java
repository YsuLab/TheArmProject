/*
 * Mock Jev-compatible decision server (PLAN.md section 0.5).
 *
 *   java MockDecisionServer.java --port 8000 [--latency-ms 150] [--jitter-ms 50]
 *                                [--error-rate 0.05] [--seed 1]
 *
 * POST /v1/systemone   body: {"model": ..., "state": "...", "questions": {...}}
 * GET  /health         -> {"ok": true}
 *
 * Logic (must match simulator/src/core/stubModel.ts):
 *   parse "left X m, ahead Y m, right Z m" from the state ("clear beyond 4 m" = 4.0)
 *   ahead > 2.0 -> forward; else the side with more clearance; all < 0.9 -> stop.
 *   Scores: winner 3.0; others clamp(score, -2, 2) with
 *     forward = ahead - 2, left = left / 2, right = right / 2, stop = 0.9 - min(all)
 *   probabilities = softmax(scores).
 * --error-rate p: with probability p the answer is deliberately wrong — the movement
 *   (forward / left / right, excluding the correct one) pointing at the LEAST clearance,
 *   so the simulator can prove arbitration overrides unsafe answers.
 *
 * The response shape is our assumption — VERIFY against real Jev; only the parser
 * (pipeline.extract_choice) should need adapting.
 * Java 21, no dependencies.
 */

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MockDecisionServer {

    static final String[] OPTIONS = {"forward", "left", "right", "stop"};
    static final Pattern CLEARANCE = Pattern.compile(
            "\\b(left|ahead|right) (?:clear beyond ([0-9.]+) m|([0-9.]+) m)");

    static int port = 8000;
    static double latencyMs = 0, jitterMs = 0, errorRate = 0;
    static Random rng = new Random();

    public static void main(String[] args) throws IOException {
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            String v = i + 1 < args.length ? args[i + 1] : null;
            switch (a) {
                case "--port" -> { port = Integer.parseInt(v); i++; }
                case "--latency-ms" -> { latencyMs = Double.parseDouble(v); i++; }
                case "--jitter-ms" -> { jitterMs = Double.parseDouble(v); i++; }
                case "--error-rate" -> { errorRate = Double.parseDouble(v); i++; }
                case "--seed" -> { rng = new Random(Long.parseLong(v)); i++; }
                case "-h", "--help" -> { System.out.println(usage()); return; }
                default -> { System.err.println("unknown option " + a + "\n" + usage()); System.exit(2); }
            }
        }
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/systemone", MockDecisionServer::handleDecision);
        server.createContext("/health", ex -> send(ex, 200, "{\"ok\": true}"));
        server.start();
        System.out.printf(Locale.ROOT,
                "Mock decision server on http://localhost:%d/v1/systemone (latency %.0f±%.0f ms, error rate %.2f)%n",
                port, latencyMs, jitterMs, errorRate);
    }

    static String usage() {
        return "java MockDecisionServer.java --port 8000 [--latency-ms 150] [--jitter-ms 50] [--error-rate 0.05] [--seed 1]";
    }

    // ------------------------------------------------------------------------- HTTP

    static void handleDecision(HttpExchange ex) throws IOException {
        if (ex.getRequestMethod().equalsIgnoreCase("OPTIONS")) { send(ex, 204, ""); return; }
        if (!ex.getRequestMethod().equalsIgnoreCase("POST")) { send(ex, 405, "{\"error\": \"POST only\"}"); return; }
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String state = jsonStringField(body, "state");
        if (state == null) { send(ex, 400, "{\"error\": \"missing 'state' string\"}"); return; }

        double delay;
        boolean wrong;
        synchronized (MockDecisionServer.class) {
            delay = Math.max(0, latencyMs + (jitterMs > 0 ? (rng.nextDouble() * 2 - 1) * jitterMs : 0));
            wrong = rng.nextDouble() < errorRate;
        }
        if (delay > 0) {
            try { Thread.sleep((long) delay); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
        Decision d = decide(parseClearance(state), wrong);
        send(ex, 200, toJson(d));
    }

    static void send(HttpExchange ex, int code, String json) throws IOException {
        byte[] out = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        // the simulator may call this server from the browser
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        ex.sendResponseHeaders(code, code == 204 ? -1 : out.length);
        if (code != 204) try (OutputStream os = ex.getResponseBody()) { os.write(out); }
        ex.close();
    }

    // ------------------------------------------------------------------------- decision logic

    record Decision(String choice, Map<String, Double> probabilities, boolean goalVisible, boolean deliberatelyWrong) {}

    /** left, ahead, right in metres; missing values default to 4.0 (clear). */
    static double[] parseClearance(String state) {
        double[] c = {4.0, 4.0, 4.0};
        String line = state;
        for (String l : state.split("\n")) if (l.startsWith("Free space")) { line = l; break; }
        Matcher m = CLEARANCE.matcher(line);
        while (m.find()) {
            double v = Double.parseDouble(m.group(2) != null ? m.group(2) : m.group(3));
            switch (m.group(1)) {
                case "left" -> c[0] = v;
                case "ahead" -> c[1] = v;
                case "right" -> c[2] = v;
            }
        }
        return c;
    }

    static int correctIndex(double left, double ahead, double right) {
        if (left < 0.9 && ahead < 0.9 && right < 0.9) return 3;   // stop
        if (ahead > 2.0) return 0;                               // forward
        return left > right ? 1 : 2;                             // more room wins (tie -> right)
    }

    static Decision decide(double[] c, boolean wrong) {
        double left = c[0], ahead = c[1], right = c[2];
        int correct = correctIndex(left, ahead, right);
        int chosen = correct;
        if (wrong) {
            // the movement with the least clearance that isn't the correct answer
            double[] clr = {ahead, left, right};
            chosen = -1;
            for (int i = 0; i < 3; i++) {
                if (i == correct) continue;
                if (chosen < 0 || clr[i] < clr[chosen]) chosen = i;
            }
        }
        double[] raw = {ahead - 2.0, left / 2.0, right / 2.0, 0.9 - Math.min(left, Math.min(ahead, right))};
        double[] score = new double[4];
        for (int i = 0; i < 4; i++) score[i] = i == chosen ? 3.0 : Math.max(-2.0, Math.min(2.0, raw[i]));
        double max = 3.0, sum = 0;
        double[] e = new double[4];
        for (int i = 0; i < 4; i++) { e[i] = Math.exp(score[i] - max); sum += e[i]; }
        Map<String, Double> probs = new LinkedHashMap<>();
        for (int i = 0; i < 4; i++) probs.put(OPTIONS[i], Math.round(e[i] / sum * 1e4) / 1e4);
        return new Decision(OPTIONS[chosen], probs, ahead > 2.0, chosen != correct);
    }

    static String toJson(Decision d) {
        StringBuilder sb = new StringBuilder("{\"answers\": {\"direction\": {\"choice\": \"")
                .append(d.choice()).append("\", \"probabilities\": {");
        int i = 0;
        for (var e : d.probabilities().entrySet()) {
            if (i++ > 0) sb.append(", ");
            sb.append('"').append(e.getKey()).append("\": ").append(String.format(Locale.ROOT, "%.4f", e.getValue()));
        }
        double pt = d.goalVisible() ? 0.72 : 0.28;
        sb.append("}}, \"goal_visible\": {\"value\": ").append(d.goalVisible())
          .append(", \"probability_true\": ").append(String.format(Locale.ROOT, "%.2f", pt))
          .append("}}, \"mock\": {\"deliberately_wrong\": ").append(d.deliberatelyWrong()).append("}}");
        return sb.toString();
    }

    // ------------------------------------------------------------------------- tiny JSON helper

    /** Value of a top-level-ish "key": "string" pair, with JSON escapes decoded. */
    static String jsonStringField(String json, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"").matcher(json);
        if (!m.find()) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = m.end(); i < json.length(); i++) {
            char ch = json.charAt(i);
            if (ch == '"') return sb.toString();
            if (ch != '\\') { sb.append(ch); continue; }
            char n = json.charAt(++i);
            switch (n) {
                case 'n' -> sb.append('\n');
                case 't' -> sb.append('\t');
                case 'r' -> sb.append('\r');
                case 'b' -> sb.append('\b');
                case 'f' -> sb.append('\f');
                case 'u' -> { sb.append((char) Integer.parseInt(json.substring(i + 1, i + 5), 16)); i += 4; }
                default -> sb.append(n);
            }
        }
        return null;
    }
}
