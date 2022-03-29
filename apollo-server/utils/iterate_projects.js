const path = require('path');
const fs = require('fs')
const {execSync} = require('child_process')
const USER_HOME_PROJECT = 'dashboard';

function exportBlueprint(cwd, fullPath) {
  const UNFURL_CMD = process.env.UNFURL_CMD || 'unfurl'
  const cmd = `${UNFURL_CMD} --home '' export --format blueprint ensemble-template.yaml`
  console.log(cmd)
  let out;
  try {
    out = execSync(cmd, { cwd });
  } catch (e) {
    console.log(`error exporting ${fullPath}:`, e)
    return false;
  }
  try {
    fs.writeFileSync(fullPath, out)
  } catch (e) {
    console.log(`error writing to ${fullPath}:`, e)
    return false;
  }
  console.log(`exported to ${fullPath}`)
  return true;
}

function getBlueprintJson(reposDir, project, runExport) {
  let jsonFile = 'blueprint.json'
  let fullPath = path.join(reposDir, project, jsonFile);
  if (!fs.existsSync(fullPath)) {
    jsonFile = 'unfurl.json'
    fullPath = path.join(reposDir, project, jsonFile);
  }
  const ensemblePath = path.join(reposDir, project, 'ensemble-template.yaml');
  if (fs.existsSync(ensemblePath)) {
    const ensembleStat = fs.statSync(ensemblePath);
    const jsonMtime = fs.existsSync(fullPath) ? fs.statSync(fullPath).mtimeMs : 0;
    if (ensembleStat.mtimeMs > jsonMtime) {
      exportBlueprint(path.join(reposDir, project), fullPath)
    }
  }
  try {
    const blueprint = JSON.parse(
      fs.readFileSync(fullPath, 'utf-8')
    )
    return blueprint;
  } catch(e) {
    console.error("in", fullPath, e)
    return null;
  }
}

function iterateProjects(reposDir) {
  const projects = []
  for (const repo of fs.readdirSync(reposDir)) {
    if (repo == "unfurl-types")
        continue
    const repoDir = path.join(reposDir, repo);
    if (!fs.statSync(repoDir).isDirectory())
        continue
    for (const project of fs.readdirSync(repoDir)) {
      if (!fs.statSync(path.join(repoDir, project)).isDirectory())
        continue
      if (project == USER_HOME_PROJECT)
        continue
      const projectPath = `${repo}/${project}`
      const blueprint = getBlueprintJson(reposDir, projectPath, true)
      if (blueprint) {
        console.log( 'adding repo', projectPath)
        projects.push({ projectPath, blueprint })
      }
    }
  }
  return projects
}

module.exports = { iterateProjects, iterateProjects };