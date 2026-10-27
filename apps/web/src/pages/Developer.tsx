import { useData } from "../api";
import { Heading, State } from "../components";
export default function Developer() {
  const data = useData(["developer"], "/developer");
  return (
    <>
      <Heading
        eyebrow="DEVELOPER ONLY"
        title="Core & OHIP Compatibility"
        description="Contract verification and runtime capabilities."
      />
      <State query={data}>
        <section className="panel padded">
          <dl>
            {Object.entries(data.data || {}).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </State>
    </>
  );
}
