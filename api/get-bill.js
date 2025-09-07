export default function handler(req, res) {
  res.json({ message: "Get bill endpoint is working", query: req.query });
}
