import fs from 'fs'
import path from 'path'


export default function iterateEnvironments(reposDir) {
  const environments = []
  for (const repo of fs.readdirSync(reposDir)) {
    if (repo == 'blueprints') continue

    try {
      const environmentsJSON = fs.readFileSync(path.join(reposDir, `${repo}/unfurl-home/environments.json`), 'utf-8')
      const parsed = JSON.parse(environmentsJSON)

      const {DeploymentEnvironment} = parsed
      environments.push({namespace: repo, clientPayload: {DeploymentEnvironment}})

    } catch(e) {
      console.error(e)
      console.error(`could not find environments.json for ${repo}`)
    }
  }

  return environments
}


//const REPOS_DIR = path.join(process.cwd(), '../repos')
//console.log(iterateEnvironments(REPOS_DIR))